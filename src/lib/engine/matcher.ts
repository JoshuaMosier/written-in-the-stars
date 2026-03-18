/**
 * Core matching pipeline: finds the best placement of glyph graph nodes onto
 * a star field by searching over (x, y, scale) transforms.
 *
 * Phase 1 (coarse search) uses equirectangular projection with a spatial hash
 * grid to quickly identify promising sky regions.
 *
 * Phase 2 (fine refinement) re-projects nearby stars onto a gnomonic tangent
 * plane centered at each candidate, then runs Nelder-Mead in that locally-
 * Euclidean space.  This eliminates the warping artefacts that equirectangular
 * projection introduces, producing constellations that look correct when
 * rendered on a 3D celestial sphere.
 */

import kdTreePkg from 'kd-tree-javascript';
const { kdTree } = kdTreePkg;
import { cmaes } from './optimizer';
import type { Star, MatchResult, GlyphGraph, MatchCostBreakdown } from './types';

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

interface Point2D {
	x: number;
	y: number;
}

/**
 * Project a star to equirectangular 2D space.
 * RA [0, 2π] → [0, 1],  Dec [-π/2, π/2] → [0, 1].
 */
function projectStarEq(star: Star): Point2D {
	return {
		x: star.ra / (2 * Math.PI),
		y: (star.dec + Math.PI / 2) / Math.PI,
	};
}

/**
 * Project a star onto a gnomonic tangent plane centered at (ra0, dec0).
 * Returns local (x, y) in radians.  x points east (increasing RA),
 * y points north (increasing Dec).  Returns null for stars behind the plane.
 */
function projectStarGnomonic(ra: number, dec: number, ra0: number, sinDec0: number, cosDec0: number): Point2D | null {
	const cosDec = Math.cos(dec);
	const sinDec = Math.sin(dec);
	const dra = ra - ra0;
	const cosDra = Math.cos(dra);
	const sinDra = Math.sin(dra);

	const cosC = sinDec0 * sinDec + cosDec0 * cosDec * cosDra;
	if (cosC <= 0.01) return null; // behind tangent plane

	const invCosC = 1 / cosC;
	return {
		x: cosDec * sinDra * invCosC,
		y: (cosDec0 * sinDec - sinDec0 * cosDec * cosDra) * invCosC,
	};
}

// ---------------------------------------------------------------------------
// Spatial hash grid for O(1)-amortized nearest-neighbor lookups
// ---------------------------------------------------------------------------

interface KDPoint {
	x: number;
	y: number;
	idx: number;
}

interface PreparedCatalog {
	eqStars: KDPoint[];
	eqGrid: StarGrid;
	eqX: Float64Array;
	eqY: Float64Array;
	sinRa: Float64Array;
	cosRa: Float64Array;
	sinDec: Float64Array;
	cosDec: Float64Array;
	minSX: number;
	maxSX: number;
	minSY: number;
	maxSY: number;
}

class StarGrid {
	private readonly cells: (KDPoint[] | null)[];
	private readonly cellSize: number;
	private readonly invCellSize: number;
	private readonly gridW: number;
	private readonly gridH: number;
	private readonly pad: number;

	lastDistSq = 0;

	// cellSize: spatial hash resolution in normalized [0,1] sky coords (~0.7° per cell)
	// pad: extra border around the [0,1] range to catch RA wraparound queries
	constructor(points: KDPoint[], cellSize = 0.012, pad = 0.15) {
		this.cellSize = cellSize;
		this.invCellSize = 1 / cellSize;
		this.pad = pad;
		const span = 1 + 2 * pad;
		this.gridW = Math.ceil(span * this.invCellSize) + 1;
		this.gridH = Math.ceil(span * this.invCellSize) + 1;
		this.cells = new Array(this.gridW * this.gridH).fill(null);

		for (const p of points) {
			const cx = Math.floor((p.x + pad) * this.invCellSize);
			const cy = Math.floor((p.y + pad) * this.invCellSize);
			if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) continue;
			const key = cy * this.gridW + cx;
			if (!this.cells[key]) this.cells[key] = [];
			this.cells[key]!.push(p);
		}
	}

	nearest1WithDist(qx: number, qy: number): KDPoint | null {
		const inv = this.invCellSize;
		const cs = this.cellSize;
		const pad = this.pad;
		const gw = this.gridW;
		const gh = this.gridH;
		const qcx = Math.floor((qx + pad) * inv);
		const qcy = Math.floor((qy + pad) * inv);

		let bestDistSq = Infinity;
		let bestPoint: KDPoint | null = null;

		for (let ring = 0; ring <= 20; ring++) {
			if (ring >= 2 && bestPoint !== null) {
				const minDist = (ring - 1) * cs;
				if (bestDistSq <= minDist * minDist) break;
			}

			for (let dx = -ring; dx <= ring; dx++) {
				for (let dy = -ring; dy <= ring; dy++) {
					if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
					const cx = qcx + dx;
					const cy = qcy + dy;
					if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
					const cell = this.cells[cy * gw + cx];
					if (!cell) continue;
					for (let i = 0; i < cell.length; i++) {
						const p = cell[i];
						const ddx = p.x - qx;
						const ddy = p.y - qy;
						const d = ddx * ddx + ddy * ddy;
						if (d < bestDistSq) {
							bestDistSq = d;
							bestPoint = p;
						}
					}
				}
			}
		}

		this.lastDistSq = bestDistSq;
		return bestPoint;
	}
}

const preparedCatalogCache = new WeakMap<Star[], PreparedCatalog>();

export function prepareMatcherCatalog(stars: Star[]): PreparedCatalog {
	const cached = preparedCatalogCache.get(stars);
	if (cached) return cached;

	const count = stars.length;
	const eqStars: KDPoint[] = new Array(count);
	const eqX = new Float64Array(count);
	const eqY = new Float64Array(count);
	const sinRa = new Float64Array(count);
	const cosRa = new Float64Array(count);
	const sinDec = new Float64Array(count);
	const cosDec = new Float64Array(count);

	let minSX = Infinity;
	let maxSX = -Infinity;
	let minSY = Infinity;
	let maxSY = -Infinity;

	for (let i = 0; i < count; i++) {
		const star = stars[i];
		const eq = projectStarEq(star);
		const sinRaVal = Math.sin(star.ra);
		const cosRaVal = Math.cos(star.ra);
		const sinDecVal = Math.sin(star.dec);
		const cosDecVal = Math.cos(star.dec);

		eqX[i] = eq.x;
		eqY[i] = eq.y;
		sinRa[i] = sinRaVal;
		cosRa[i] = cosRaVal;
		sinDec[i] = sinDecVal;
		cosDec[i] = cosDecVal;
		eqStars[i] = { x: eq.x, y: eq.y, idx: i };

		if (eq.x < minSX) minSX = eq.x;
		if (eq.x > maxSX) maxSX = eq.x;
		if (eq.y < minSY) minSY = eq.y;
		if (eq.y > maxSY) maxSY = eq.y;
	}

	const prepared: PreparedCatalog = {
		eqStars,
		eqGrid: new StarGrid(eqStars),
		eqX,
		eqY,
		sinRa,
		cosRa,
		sinDec,
		cosDec,
		minSX,
		maxSX,
		minSY,
		maxSY,
	};
	preparedCatalogCache.set(stars, prepared);
	return prepared;
}

// ---------------------------------------------------------------------------
// Cost computation — equirectangular (coarse grid search)
// ---------------------------------------------------------------------------

const POINT_DISTANCE_WEIGHT = 1.0;
const POINT_DISTANCE_SQ_WEIGHT = 1.0;
const EDGE_SHAPE_WEIGHT = 1.5;
const DUPLICATE_WEIGHT = 0.3;
const BLACKLIST_WEIGHT = 2.0;

function totalMatchCost(
	pointDistance: number,
	pointDistanceSq: number,
	edgeShape: number,
	duplicates: number,
	blacklist: number,
): number {
	return (
		pointDistance * POINT_DISTANCE_WEIGHT +
		pointDistanceSq * POINT_DISTANCE_SQ_WEIGHT +
		edgeShape * EDGE_SHAPE_WEIGHT +
		duplicates * DUPLICATE_WEIGHT +
		blacklist * BLACKLIST_WEIGHT
	);
}

function makeMatchCostBreakdown(
	pointDistance: number,
	pointDistanceSq: number,
	edgeShape: number,
	duplicates: number,
	blacklist: number,
): MatchCostBreakdown {
	return {
		pointDistance,
		pointDistanceSq,
		edgeShape,
		duplicates,
		blacklist,
		total: totalMatchCost(pointDistance, pointDistanceSq, edgeShape, duplicates, blacklist),
	};
}

function computeAssignedMatchCost(
	projected: Point2D[],
	starPositions: Point2D[],
	assignedStarIdx: Int32Array,
	edges: [number, number][],
	scale: number,
	blacklist: Set<number> | null = null,
): MatchCostBreakdown {
	if (scale <= 0) {
		return makeMatchCostBreakdown(Infinity, 0, 0, 0, 0);
	}

	const invScale = 1 / scale;
	let pointDistance = 0;
	let pointDistanceSq = 0;
	let edgeShape = 0;
	let blacklistPenalty = 0;
	let uniqueCount = 0;
	const seenStars = new Set<number>();

	for (let i = 0; i < assignedStarIdx.length; i++) {
		const starIdx = assignedStarIdx[i];
		const starPos = starIdx >= 0 ? starPositions[starIdx] : undefined;
		if (!starPos) {
			pointDistance += invScale;
			pointDistanceSq += invScale * invScale;
			continue;
		}

		const dx = starPos.x - projected[i].x;
		const dy = starPos.y - projected[i].y;
		const d = Math.sqrt(dx * dx + dy * dy) * invScale;
		pointDistance += d;
		pointDistanceSq += d * d;
		if (blacklist && blacklist.has(starIdx)) blacklistPenalty += 1;
		if (!seenStars.has(starIdx)) {
			seenStars.add(starIdx);
			uniqueCount++;
		}
	}

	for (let e = 0; e < edges.length; e++) {
		const nA = edges[e][0];
		const nB = edges[e][1];
		const starA = assignedStarIdx[nA] >= 0 ? starPositions[assignedStarIdx[nA]] : undefined;
		const starB = assignedStarIdx[nB] >= 0 ? starPositions[assignedStarIdx[nB]] : undefined;
		if (!starA || !starB) {
			edgeShape += invScale;
			continue;
		}

		const errX = starB.x - starA.x - (projected[nB].x - projected[nA].x);
		const errY = starB.y - starA.y - (projected[nB].y - projected[nA].y);
		edgeShape += Math.sqrt(errX * errX + errY * errY) * invScale;
	}

	return makeMatchCostBreakdown(
		pointDistance,
		pointDistanceSq,
		edgeShape,
		assignedStarIdx.length - uniqueCount,
		blacklistPenalty,
	);
}

function computeCostEq(
	grid: StarGrid,
	anchorDx: Float64Array,
	anchorDy: Float64Array,
	edges: [number, number][],
	tx: number,
	ty: number,
	scale: number,
	projX: Float64Array,
	projY: Float64Array,
	nearestIdx: Int32Array,
	nearestX: Float64Array,
	nearestY: Float64Array,
	usedGen: Uint32Array,
	gen: number,
	costCeiling: number,
	blacklist: Set<number> | null = null,
): number {
	if (scale <= 0) return 1e12;

	const n = anchorDx.length;
	const invScale = 1 / scale;
	let pointDistance = 0;
	let pointDistanceSq = 0;
	let blacklistPenalty = 0;
	let uniqueCount = 0;

	for (let i = 0; i < n; i++) {
		const pointY = ty + scale * anchorDy[i];
		const pointDec = pointY * Math.PI - Math.PI / 2;
		const cosDec = Math.cos(pointDec);
		const xStretch = Math.min(2.5, cosDec > 0.1 ? 1 / cosDec : 2.5);
		const px = tx - scale * anchorDx[i] * xStretch;
		projX[i] = px;
		projY[i] = pointY;

		const nn = grid.nearest1WithDist(px, pointY);
		if (nn) {
			const d = Math.sqrt(grid.lastDistSq) * invScale;
			pointDistance += d;
			pointDistanceSq += d * d;
			if (blacklist && blacklist.has(nn.idx)) blacklistPenalty += 1;
			nearestIdx[i] = nn.idx;
			nearestX[i] = nn.x;
			nearestY[i] = nn.y;
			if (usedGen[nn.idx] !== gen) {
				usedGen[nn.idx] = gen;
				uniqueCount++;
			}
		} else {
			pointDistance += invScale;
			pointDistanceSq += invScale * invScale;
			nearestIdx[i] = -1;
		}

		const partialTotal =
			pointDistance * POINT_DISTANCE_WEIGHT +
			pointDistanceSq * POINT_DISTANCE_SQ_WEIGHT +
			blacklistPenalty * BLACKLIST_WEIGHT;
		if (partialTotal > costCeiling) return partialTotal;
	}

	let edgeShape = 0;
	for (let e = 0; e < edges.length; e++) {
		const nA = edges[e][0];
		const nB = edges[e][1];
		if (nearestIdx[nA] === -1 || nearestIdx[nB] === -1) {
			edgeShape += invScale;
			continue;
		}
		const errX = nearestX[nB] - nearestX[nA] - (projX[nB] - projX[nA]);
		const errY = nearestY[nB] - nearestY[nA] - (projY[nB] - projY[nA]);
		edgeShape += Math.sqrt(errX * errX + errY * errY) * invScale;
	}

	// 1.5× edge weight: penalize shape distortion more than raw distance
	// 0.3× duplicate penalty: discourage reusing the same star for multiple nodes
	return totalMatchCost(pointDistance, pointDistanceSq, edgeShape, n - uniqueCount, blacklistPenalty);
}

// ---------------------------------------------------------------------------
// Cost computation — gnomonic (NM refinement)
// ---------------------------------------------------------------------------

function computeCostGnomonic(
	grid: StarGrid,
	anchorDx: Float64Array,
	anchorDy: Float64Array,
	edges: [number, number][],
	offX: number,
	offY: number,
	scale: number,
	projX: Float64Array,
	projY: Float64Array,
	nearestIdx: Int32Array,
	nearestX: Float64Array,
	nearestY: Float64Array,
	usedGen: Uint32Array,
	gen: number,
	costCeiling = Infinity,
	blacklist: Set<number> | null = null,
): number {
	if (scale <= 0) return 1e12;

	const n = anchorDx.length;
	const invScale = 1 / scale;
	let pointDistance = 0;
	let pointDistanceSq = 0;
	let blacklistPenalty = 0;
	let uniqueCount = 0;

	// In gnomonic space: no cos(dec) correction needed — isotropic geometry
	for (let i = 0; i < n; i++) {
		const px = offX - scale * anchorDx[i];
		const py = offY + scale * anchorDy[i];
		projX[i] = px;
		projY[i] = py;

		const nn = grid.nearest1WithDist(px, py);
		if (nn) {
			const d = Math.sqrt(grid.lastDistSq) * invScale;
			pointDistance += d;
			pointDistanceSq += d * d;
			if (blacklist && blacklist.has(nn.idx)) blacklistPenalty += 1;
			nearestIdx[i] = nn.idx;
			nearestX[i] = nn.x;
			nearestY[i] = nn.y;
			if (usedGen[nn.idx] !== gen) {
				usedGen[nn.idx] = gen;
				uniqueCount++;
			}
		} else {
			pointDistance += invScale;
			pointDistanceSq += invScale * invScale;
			nearestIdx[i] = -1;
		}

		const partialTotal =
			pointDistance * POINT_DISTANCE_WEIGHT +
			pointDistanceSq * POINT_DISTANCE_SQ_WEIGHT +
			blacklistPenalty * BLACKLIST_WEIGHT;
		if (partialTotal > costCeiling) return partialTotal;
	}

	let edgeShape = 0;
	for (let e = 0; e < edges.length; e++) {
		const nA = edges[e][0];
		const nB = edges[e][1];
		if (nearestIdx[nA] === -1 || nearestIdx[nB] === -1) {
			edgeShape += invScale;
			continue;
		}
		const errX = nearestX[nB] - nearestX[nA] - (projX[nB] - projX[nA]);
		const errY = nearestY[nB] - nearestY[nA] - (projY[nB] - projY[nA]);
		edgeShape += Math.sqrt(errX * errX + errY * errY) * invScale;
	}

	return totalMatchCost(pointDistance, pointDistanceSq, edgeShape, n - uniqueCount, blacklistPenalty);
}

// ---------------------------------------------------------------------------
// Duplicate resolution
// ---------------------------------------------------------------------------

function resolveDuplicates(
	gnoStars: KDPoint[],
	gnoStarPositions: Point2D[],
	projected: Point2D[],
	stars: Star[],
	nodeCount: number,
	edges: [number, number][],
): { pairs: { star: Star; nodeIndex: number }[]; assignment: Int32Array } {
	// Build KD-tree in gnomonic space for k-nearest queries
	const gnoTree = new kdTree(
		gnoStars,
		(a: KDPoint, b: KDPoint) => {
			const dx = a.x - b.x;
			const dy = a.y - b.y;
			return dx * dx + dy * dy;
		},
		['x', 'y'],
	);

	const k = Math.min(50, gnoStars.length);

	const candidates: { starIdx: number; dist: number }[][] = projected.map((p) => {
		const nearest = gnoTree.nearest(p as KDPoint, k);
		return nearest.map((n: [KDPoint, number]) => ({ starIdx: n[0].idx, dist: n[1] }));
	});

	const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
	for (const [nA, nB] of edges) {
		adjacency[nA].push(nB);
		adjacency[nB].push(nA);
	}

	// --- Phase 1: Greedy assignment (closest-first) ---
	const sortedNodes = Array.from({ length: nodeCount }, (_, i) => i);
	sortedNodes.sort((a, b) => {
		const da = candidates[a].length > 0 ? candidates[a][0].dist : Infinity;
		const db = candidates[b].length > 0 ? candidates[b][0].dist : Infinity;
		return da - db;
	});

	const assignment: number[] = new Array(nodeCount).fill(-1);
	const usedStars = new Set<number>();

	for (const nodeIdx of sortedNodes) {
		const cands = candidates[nodeIdx];
		for (const c of cands) {
			if (!usedStars.has(c.starIdx)) {
				usedStars.add(c.starIdx);
				assignment[nodeIdx] = c.starIdx;
				break;
			}
		}
		if (assignment[nodeIdx] === -1 && cands.length > 0) {
			assignment[nodeIdx] = cands[0].starIdx;
		}
	}

	// --- Phase 2: Iterative swap refinement ---
	const starToNode = new Map<number, number>();
	for (let i = 0; i < nodeCount; i++) {
		if (assignment[i] !== -1) {
			starToNode.set(assignment[i], i);
		}
	}

	const nodeEdgeCost = (nodeIdx: number): number => {
		let cost = 0;
		const starPos = gnoStarPositions[assignment[nodeIdx]];
		if (!starPos) return 1e6;
		for (const neighbor of adjacency[nodeIdx]) {
			if (assignment[neighbor] === -1) continue;
			const neighborStarPos = gnoStarPositions[assignment[neighbor]];
			if (!neighborStarPos) continue;
			const expectedDx = projected[neighbor].x - projected[nodeIdx].x;
			const expectedDy = projected[neighbor].y - projected[nodeIdx].y;
			const actualDx = neighborStarPos.x - starPos.x;
			const actualDy = neighborStarPos.y - starPos.y;
			const errX = actualDx - expectedDx;
			const errY = actualDy - expectedDy;
			cost += Math.sqrt(errX * errX + errY * errY);
		}
		const dx = starPos.x - projected[nodeIdx].x;
		const dy = starPos.y - projected[nodeIdx].y;
		cost += Math.sqrt(dx * dx + dy * dy);
		return cost;
	};

	const MAX_ROUNDS = 5;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		let improved = false;

		for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) {
			const currentStar = assignment[nodeIdx];
			const currentNodeCost = nodeEdgeCost(nodeIdx);
			let bestImprovement = 0;
			let bestStar = currentStar;
			let bestSwapNode = -1;

			for (const c of candidates[nodeIdx]) {
				if (c.starIdx === currentStar) continue;
				const ownerNode = starToNode.get(c.starIdx) ?? -1;

				if (ownerNode === -1) {
					assignment[nodeIdx] = c.starIdx;
					const improvement = currentNodeCost - nodeEdgeCost(nodeIdx);
					if (improvement > bestImprovement) {
						bestImprovement = improvement;
						bestStar = c.starIdx;
						bestSwapNode = -1;
					}
					assignment[nodeIdx] = currentStar;
				} else {
					const oldTotal = currentNodeCost + nodeEdgeCost(ownerNode);
					assignment[nodeIdx] = c.starIdx;
					assignment[ownerNode] = currentStar;
					const newTotal = nodeEdgeCost(nodeIdx) + nodeEdgeCost(ownerNode);
					const improvement = oldTotal - newTotal;
					if (improvement > bestImprovement) {
						bestImprovement = improvement;
						bestStar = c.starIdx;
						bestSwapNode = ownerNode;
					}
					assignment[nodeIdx] = currentStar;
					assignment[ownerNode] = c.starIdx;
				}
			}

			if (bestStar !== currentStar) {
				starToNode.delete(currentStar);
				starToNode.set(bestStar, nodeIdx);
				if (bestSwapNode === -1) {
					usedStars.delete(currentStar);
					usedStars.add(bestStar);
					assignment[nodeIdx] = bestStar;
				} else {
					starToNode.set(currentStar, bestSwapNode);
					assignment[nodeIdx] = bestStar;
					assignment[bestSwapNode] = currentStar;
				}
				improved = true;
			}
		}

		if (!improved) break;
	}

	const result: { star: Star; nodeIndex: number }[] = [];
	for (let i = 0; i < nodeCount; i++) {
		if (assignment[i] !== -1) {
			result.push({ star: stars[assignment[i]], nodeIndex: i });
		}
	}
	return { pairs: result, assignment: Int32Array.from(assignment) };
}

// ---------------------------------------------------------------------------
// Main matching pipeline
// ---------------------------------------------------------------------------

/**
 * Find the best placement of a glyph graph onto a real star field.
 *
 * Searches over (position, scale) transforms in three phases:
 * 1. **Coarse grid search** — scans the sky in equirectangular space with a
 *    hierarchical grid + RANSAC-style edge hypotheses to find promising regions.
 * 2. **Gnomonic refinement** — re-projects stars onto a gnomonic tangent plane
 *    at each candidate and runs CMA-ES to minimize placement cost in locally-
 *    Euclidean space (eliminates equirectangular warping artifacts).
 * 3. **Duplicate resolution** — assigns unique stars to nodes via greedy +
 *    iterative swap refinement using a KD-tree for k-nearest candidates.
 *
 * @param stars - Full star catalog
 * @param graph - Glyph graph from {@link textToGraph}
 * @param blacklist - Star indices to penalize (e.g. already used in other constellations)
 * @param onProgress - Optional callback with progress fraction [0, 1]
 * @returns Best match with star-to-node pairs, cost, and camera transform
 */
export function matchStarsToAnchors(
	stars: Star[],
	graph: GlyphGraph,
	blacklist: Set<number> | null = null,
	onProgress?: (pct: number) => void,
): MatchResult {
	const { nodes, edges } = graph;

	if (nodes.length === 0 || stars.length === 0) {
		return { pairs: [], cost: Infinity, transform: { x: 0, y: 0, scale: 0 }, graph };
	}

	const prepared = prepareMatcherCatalog(stars);
	const { eqStars, eqGrid, minSX: preparedMinSX, maxSX: preparedMaxSX, minSY: preparedMinSY, maxSY: preparedMaxSY } =
		prepared;

	// --- Compute node centroid and pre-center anchor offsets ---
	const n = nodes.length;
	let cx = 0;
	let cy = 0;
	for (const a of nodes) {
		cx += a.x;
		cy += a.y;
	}
	cx /= n;
	cy /= n;

	const anchorDx = new Float64Array(n);
	const anchorDy = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		anchorDx[i] = nodes[i].x - cx;
		anchorDy[i] = nodes[i].y - cy;
	}

	// --- Compute equirectangular star field extent ---
	// Clamp y-range to ±65° declination (0.139 ≈ 25°/180°) for coarse search.
	// Near the poles equirectangular projection distorts too heavily for the
	// coarse grid to be useful; gnomonic refinement handles any declination.
	const Y_MIN_CLAMP = 0.139; // ~-65° dec in [0,1] normalized space
	const Y_MAX_CLAMP = 0.861; // ~+65° dec
	const minSX = preparedMinSX;
	const maxSX = preparedMaxSX;
	const minSY = Math.max(preparedMinSY, Y_MIN_CLAMP);
	const maxSY = Math.min(preparedMaxSY, Y_MAX_CLAMP);

	// --- Coarse grid search in equirectangular space ---
	let anchorMinX = Infinity,
		anchorMaxX = -Infinity;
	for (let i = 0; i < n; i++) {
		if (anchorDx[i] < anchorMinX) anchorMinX = anchorDx[i];
		if (anchorDx[i] > anchorMaxX) anchorMaxX = anchorDx[i];
	}
	const anchorWidth = anchorMaxX - anchorMinX || 1;
	const maxAngularSpan = 0.139; // ~50° — largest constellation footprint to consider
	const maxScale = maxAngularSpan / anchorWidth;
	const allScales = [0.012, 0.015, 0.018, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.065, 0.08, 0.1, 0.13, 0.17, 0.22];
	const scaleValues = allScales.filter((s) => s <= maxScale);
	if (scaleValues.length < 3) {
		for (const s of allScales) {
			if (!scaleValues.includes(s)) scaleValues.push(s);
			if (scaleValues.length >= 3) break;
		}
		scaleValues.sort((a, b) => a - b);
	}

	const rangeX = maxSX - minSX || 1;
	const rangeY = maxSY - minSY || 1;

	interface Candidate {
		tx: number;
		ty: number;
		scale: number;
		cost: number;
	}

	const topN = 80; // number of best candidates to keep for gnomonic refinement
	const best: Candidate[] = [];
	let worstBestCost = Infinity;

	const insertCandidate = (c: Candidate): void => {
		if (best.length < topN) {
			let lo = 0,
				hi = best.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (best[mid].cost < c.cost) lo = mid + 1;
				else hi = mid;
			}
			best.splice(lo, 0, c);
			if (best.length === topN) worstBestCost = best[topN - 1].cost;
		} else if (c.cost < worstBestCost) {
			let lo = 0,
				hi = topN - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (best[mid].cost < c.cost) lo = mid + 1;
				else hi = mid;
			}
			best.splice(lo, 0, c);
			best.length = topN;
			worstBestCost = best[topN - 1].cost;
		}
	};

	// Pre-allocate scratch arrays
	const projX = new Float64Array(n);
	const projY = new Float64Array(n);
	const nearestIdx = new Int32Array(n);
	const nearestXArr = new Float64Array(n);
	const nearestYArr = new Float64Array(n);
	const usedGen = new Uint32Array(stars.length);
	let gen = 0;

	// ---------------------------------------------------------------------------
	// Hierarchical coarse search:
	//   Pass 1 — coarse grid (with jitter), keep top regions
	//   Pass 2 — refine each region in a fine neighborhood + scale neighbors
	// ---------------------------------------------------------------------------

	const coarseStepsX = 40;
	const coarseStepsY = 40;
	const coarseTopN = 300; // keep top 300 coarse candidates for fine-grid refinement
	const coarseBest: Candidate[] = [];
	let coarseWorstCost = Infinity;

	const insertCoarse = (c: Candidate): void => {
		if (coarseBest.length < coarseTopN) {
			let lo = 0,
				hi = coarseBest.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (coarseBest[mid].cost < c.cost) lo = mid + 1;
				else hi = mid;
			}
			coarseBest.splice(lo, 0, c);
			if (coarseBest.length === coarseTopN) coarseWorstCost = coarseBest[coarseTopN - 1].cost;
		} else if (c.cost < coarseWorstCost) {
			let lo = 0,
				hi = coarseTopN - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (coarseBest[mid].cost < c.cost) lo = mid + 1;
				else hi = mid;
			}
			coarseBest.splice(lo, 0, c);
			coarseBest.length = coarseTopN;
			coarseWorstCost = coarseBest[coarseTopN - 1].cost;
		}
	};

	const jitterOffsets = [
		[0, 0],
		[0.33, 0.33],
		[0.67, 0.67],
	];

	const coarseCellW = rangeX / coarseStepsX;
	const coarseCellH = rangeY / coarseStepsY;

	// Pass 1: coarse grid with scale-adaptive stepping
	// At large scales the glyph covers many cells, so adjacent positions are
	// highly correlated. Skip redundant positions proportionally.
	for (const [jx, jy] of jitterOffsets) {
		for (const scale of scaleValues) {
			const strideX = Math.max(1, Math.floor(scale / coarseCellW));
			const strideY = Math.max(1, Math.floor(scale / coarseCellH));
			for (let xi = 0; xi < coarseStepsX; xi += strideX) {
				const tx = minSX + (rangeX * (xi + jx + 0.5)) / coarseStepsX;
				for (let yi = 0; yi < coarseStepsY; yi += strideY) {
					const ty = minSY + (rangeY * (yi + jy + 0.5)) / coarseStepsY;
					gen++;
					const cost = computeCostEq(
						eqGrid,
						anchorDx,
						anchorDy,
						edges,
						tx,
						ty,
						scale,
						projX,
						projY,
						nearestIdx,
						nearestXArr,
						nearestYArr,
						usedGen,
						gen,
						coarseWorstCost,
						blacklist,
					);
					insertCoarse({ tx, ty, scale, cost });
				}
			}
		}
	}

	// Pass 2: refine each coarse winner in a fine neighborhood + scale neighbors
	const fineSteps = 5;
	const fineHalfW = coarseCellW * 0.6;
	const fineHalfH = coarseCellH * 0.6;
	const fineStepW = (2 * fineHalfW) / fineSteps;
	const fineStepH = (2 * fineHalfH) / fineSteps;

	const visitedFine = new Set<string>();

	for (const cand of coarseBest) {
		const cellKey = `${Math.round(cand.tx / coarseCellW)}:${Math.round(cand.ty / coarseCellH)}:${cand.scale}`;
		if (visitedFine.has(cellKey)) continue;
		visitedFine.add(cellKey);

		const scaleIdx = scaleValues.indexOf(cand.scale);
		const fineScales: number[] = [cand.scale];
		if (scaleIdx > 0) fineScales.push(scaleValues[scaleIdx - 1]);
		if (scaleIdx < scaleValues.length - 1) fineScales.push(scaleValues[scaleIdx + 1]);

		for (const fineScale of fineScales) {
			for (let fi = 0; fi < fineSteps; fi++) {
				const ftx = cand.tx - fineHalfW + fineStepW * (fi + 0.5);
				for (let fj = 0; fj < fineSteps; fj++) {
					const fty = cand.ty - fineHalfH + fineStepH * (fj + 0.5);
					gen++;
					const cost = computeCostEq(
						eqGrid,
						anchorDx,
						anchorDy,
						edges,
						ftx,
						fty,
						fineScale,
						projX,
						projY,
						nearestIdx,
						nearestXArr,
						nearestYArr,
						usedGen,
						gen,
						worstBestCost,
						blacklist,
					);
					insertCandidate({ tx: ftx, ty: fty, scale: fineScale, cost });
				}
			}
		}
	}

	onProgress?.(0.25);

	// ---------------------------------------------------------------------------
	// Edge-based candidate generation (RANSAC-style)
	// For anchor edges, hypothesize each star matches one endpoint, verify the
	// other endpoint has a nearby star, and derive the implied transform.
	// Uses ALL stars (no sampling) for complete coverage.
	// ---------------------------------------------------------------------------

	const edgeInfos = edges.map(([a, b]) => {
		const dx = anchorDx[a] - anchorDx[b];
		const dy = anchorDy[a] - anchorDy[b];
		return { a, b, dx, dy, len: Math.sqrt(dx * dx + dy * dy) };
	});
	edgeInfos.sort((a, b) => b.len - a.len);
	const ransacEdges = edgeInfos.slice(0, Math.min(2, edgeInfos.length));

	// Sample stars with a stride; use two different offsets to catch different stars
	const ransacSampleSize = 1500;
	const ransacStride = Math.max(1, Math.floor(eqStars.length / ransacSampleSize));

	for (const re of ransacEdges) {
		for (let si = 0; si < eqStars.length; si += ransacStride) {
			const s1 = eqStars[si];

			for (const scale of scaleValues) {
				// Compute implied center if s1 matches node A
				const ty = s1.y - scale * anchorDy[re.a];
				if (ty < minSY || ty > maxSY) continue;

				const pointDec = ty * Math.PI - Math.PI / 2;
				const cosDec = Math.cos(pointDec);
				const xStretch = Math.min(2.5, cosDec > 0.1 ? 1 / cosDec : 2.5);
				const tx = s1.x + scale * anchorDx[re.a] * xStretch;

				// Check where node B's star should be
				const expectedX = tx - scale * anchorDx[re.b] * xStretch;
				const expectedY = ty + scale * anchorDy[re.b];
				const match = eqGrid.nearest1WithDist(expectedX, expectedY);
				if (!match) continue;

				// Accept if the nearest star is close enough (within 20% of scale)
				const matchDist = Math.sqrt(eqGrid.lastDistSq);
				if (matchDist > scale * 0.2) continue;

				// Score and insert
				gen++;
				const cost = computeCostEq(
					eqGrid,
					anchorDx,
					anchorDy,
					edges,
					tx,
					ty,
					scale,
					projX,
					projY,
					nearestIdx,
					nearestXArr,
					nearestYArr,
					usedGen,
					gen,
					worstBestCost,
					blacklist,
				);
				insertCandidate({ tx, ty, scale, cost });
			}
		}
	}

	onProgress?.(0.4);

	// =========================================================================
	// Phase 2: Gnomonic refinement of top candidates
	// =========================================================================

	// For each top candidate, project nearby stars onto a gnomonic tangent plane
	// centered at the candidate's equirectangular position, then run Nelder-Mead
	// in that locally-Euclidean space.

	interface NMResult {
		params: number[];
		cost: number;
		ra0: number;
		dec0: number;
	}

	let bestResult: NMResult = { params: [0, 0, 0], cost: Infinity, ra0: 0, dec0: 0 };

	// Scratch arrays reusable across candidates (gnomonic cost fn uses same layout)
	const gnoProjX = new Float64Array(n);
	const gnoProjY = new Float64Array(n);
	const gnoNearIdx = new Int32Array(n);
	const gnoNearX = new Float64Array(n);
	const gnoNearY = new Float64Array(n);

	// Helper to build gnomonic grid for a given sky center
	const buildGnoGrid = (ra0: number, dec0: number): { grid: StarGrid; points: KDPoint[] } | null => {
		const sinRa0 = Math.sin(ra0);
		const cosRa0 = Math.cos(ra0);
		const sinDec0 = Math.sin(dec0);
		const cosDec0 = Math.cos(dec0);
		const gnoPoints: KDPoint[] = [];
		const maxCosC = Math.cos((40 * Math.PI) / 180);
		const { sinRa, cosRa, sinDec, cosDec } = prepared;

		for (let i = 0; i < stars.length; i++) {
			const sinDecI = sinDec[i];
			const cosDecI = cosDec[i];
			const cosDra = cosRa[i] * cosRa0 + sinRa[i] * sinRa0;
			const sinDra = sinRa[i] * cosRa0 - cosRa[i] * sinRa0;
			const cosC = sinDec0 * sinDecI + cosDec0 * cosDecI * cosDra;
			if (cosC <= maxCosC) continue;

			const invCosC = 1 / cosC;
			gnoPoints.push({
				x: cosDecI * sinDra * invCosC,
				y: (cosDec0 * sinDecI - sinDec0 * cosDecI * cosDra) * invCosC,
				idx: i,
			});
		}

		if (gnoPoints.length < n) return null;

		const gnoCellSize = 1.7 / Math.sqrt(gnoPoints.length);
		return { grid: new StarGrid(gnoPoints, gnoCellSize, 1.0), points: gnoPoints };
	};

	// Phase 2: NM refinement with multi-start on all coarse candidates
	// Cache gnomonic grids — candidates near the same sky position share a grid
	const gnoGridCache = new Map<string, { grid: StarGrid; ra0: number; dec0: number } | null>();
	const GNO_CACHE_RES = 0.02; // ~1° snap grid — nearby candidates share a gnomonic projection

	const bestLen = best.length;
	for (let ci = 0; ci < bestLen; ci++) {
		const candidate = best[ci];
		if (ci % 10 === 0) onProgress?.(0.4 + 0.5 * (ci / bestLen));
		const ra0 = candidate.tx * 2 * Math.PI;
		const dec0 = candidate.ty * Math.PI - Math.PI / 2;

		// Snap to cache grid
		const cacheKey = `${Math.round(ra0 / GNO_CACHE_RES)}:${Math.round(dec0 / GNO_CACHE_RES)}`;
		let cachedGno = gnoGridCache.get(cacheKey);
		if (cachedGno === undefined) {
			const gno = buildGnoGrid(ra0, dec0);
			cachedGno = gno ? { grid: gno.grid, ra0, dec0 } : null;
			gnoGridCache.set(cacheKey, cachedGno);
		}
		if (!cachedGno) continue;

		// Compute candidate center offset in cached grid's gnomonic space
		const gridRa0 = cachedGno.ra0;
		const gridDec0 = cachedGno.dec0;
		const gnoOff = projectStarGnomonic(ra0, dec0, gridRa0, Math.sin(gridDec0), Math.cos(gridDec0));
		const offX0 = gnoOff ? gnoOff.x : 0;
		const offY0 = gnoOff ? gnoOff.y : 0;

		const gnoScaleInit = candidate.scale * Math.PI;
		let gnoGen = gen;

		const costFn = (p: number[]): number => {
			gnoGen++;
			return computeCostGnomonic(
				cachedGno!.grid,
				anchorDx,
				anchorDy,
				edges,
				p[0],
				p[1],
				p[2],
				gnoProjX,
				gnoProjY,
				gnoNearIdx,
				gnoNearX,
				gnoNearY,
				usedGen,
				gnoGen,
				bestResult.cost,
				blacklist,
			);
		};

		const searchRadius = Math.max(0.003, gnoScaleInit * 0.15);
		const startPoint = [offX0, offY0, gnoScaleInit];
		// Two CMA-ES runs with different seeds for broader exploration.
		const cmaStarts = [startPoint, [offX0 + searchRadius * 0.01, offY0 + searchRadius * 0.01, gnoScaleInit]];
		for (const cmaStart of cmaStarts) {
			const optimized = cmaes(costFn, cmaStart, { sigma: searchRadius, maxEvals: 350 });
			const cost = costFn(optimized);
			if (cost < bestResult.cost) {
				bestResult = { params: optimized, cost, ra0: gridRa0, dec0: gridDec0 };
			}
		}

		gen = gnoGen;
	}

	onProgress?.(0.9);

	// =========================================================================
	// Phase 3: Final pair assignment in gnomonic space
	// =========================================================================

	const { ra0, dec0 } = bestResult;
	const sinRa0 = Math.sin(ra0);
	const cosRa0 = Math.cos(ra0);
	const sinDec0 = Math.sin(dec0);
	const cosDec0 = Math.cos(dec0);
	const [offX, offY, gnoScale] = bestResult.params;

	// Project all stars to gnomonic space for final k-nearest assignment
	const gnoStarsFinal: KDPoint[] = [];
	const gnoStarPositions: Point2D[] = new Array(stars.length);
	const { sinRa, cosRa, sinDec, cosDec } = prepared;
	for (let i = 0; i < stars.length; i++) {
		const sinDecI = sinDec[i];
		const cosDecI = cosDec[i];
		const cosDra = cosRa[i] * cosRa0 + sinRa[i] * sinRa0;
		const sinDra = sinRa[i] * cosRa0 - cosRa[i] * sinRa0;
		const cosC = sinDec0 * sinDecI + cosDec0 * cosDecI * cosDra;
		if (cosC <= 0.01) continue;

		const invCosC = 1 / cosC;
		const gp = {
			x: cosDecI * sinDra * invCosC,
			y: (cosDec0 * sinDecI - sinDec0 * cosDecI * cosDra) * invCosC,
		};
		gnoStarsFinal.push({ x: gp.x, y: gp.y, idx: i });
		gnoStarPositions[i] = gp;
	}

	// Project anchors in gnomonic space
	const finalProjected: Point2D[] = [];
	for (let i = 0; i < n; i++) {
		finalProjected.push({
			x: offX - gnoScale * anchorDx[i],
			y: offY + gnoScale * anchorDy[i],
		});
	}

	const { pairs, assignment: assignedStarIdx } = resolveDuplicates(
		gnoStarsFinal,
		gnoStarPositions,
		finalProjected,
		stars,
		nodes.length,
		edges,
	);
	const costBreakdown = computeAssignedMatchCost(
		finalProjected,
		gnoStarPositions,
		assignedStarIdx,
		edges,
		gnoScale,
		blacklist,
	);

	// Convert gnomonic center + offset back to equirectangular for camera
	// Inverse gnomonic: recover (ra, dec) from tangent-plane (x, y)
	const rho = Math.sqrt(offX * offX + offY * offY);
	let finalRa: number, finalDec: number;
	if (rho < 1e-10) {
		finalRa = ra0;
		finalDec = dec0;
	} else {
		const c = Math.atan(rho);
		const sinC = Math.sin(c);
		const cosC = Math.cos(c);
		finalDec = Math.asin(cosC * sinDec0 + (offY * sinC * cosDec0) / rho);
		finalRa = ra0 + Math.atan2(offX * sinC, rho * cosDec0 * cosC - offY * sinDec0 * sinC);
	}

	// Normalize RA to [0, 2π)
	const normRa = ((finalRa % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

	return {
		pairs,
		cost: costBreakdown.total,
		searchCost: bestResult.cost,
		costBreakdown,
		transform: {
			x: normRa / (2 * Math.PI),
			y: (finalDec + Math.PI / 2) / Math.PI,
			scale: gnoScale,
		},
		graph,
	};
}
