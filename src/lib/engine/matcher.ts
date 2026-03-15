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

// @ts-ignore - CJS module
import kdTreePkg from 'kd-tree-javascript';
const { kdTree } = kdTreePkg;
import { nelderMead } from './optimizer';
import type { Star, AnchorPoint, MatchResult, GlyphGraph } from './types';

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
function projectStarGnomonic(
  ra: number,
  dec: number,
  ra0: number,
  sinDec0: number,
  cosDec0: number,
): Point2D | null {
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

class StarGrid {
  private readonly cells: (KDPoint[] | null)[];
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly gridW: number;
  private readonly gridH: number;
  private readonly pad: number;

  lastDistSq = 0;

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

// ---------------------------------------------------------------------------
// Cost computation — equirectangular (coarse grid search)
// ---------------------------------------------------------------------------

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
): number {
  if (scale <= 0) return 1e12;

  const n = anchorDx.length;
  const invScale = 1 / scale;
  let totalDist = 0;
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
      totalDist += d + d * d;
      nearestIdx[i] = nn.idx;
      nearestX[i] = nn.x;
      nearestY[i] = nn.y;
      if (usedGen[nn.idx] !== gen) {
        usedGen[nn.idx] = gen;
        uniqueCount++;
      }
    } else {
      totalDist += invScale + invScale * invScale;
      nearestIdx[i] = -1;
    }

    if (totalDist > costCeiling) return totalDist;
  }

  let edgeCost = 0;
  for (let e = 0; e < edges.length; e++) {
    const nA = edges[e][0];
    const nB = edges[e][1];
    if (nearestIdx[nA] === -1 || nearestIdx[nB] === -1) {
      edgeCost += invScale;
      continue;
    }
    const errX = (nearestX[nB] - nearestX[nA]) - (projX[nB] - projX[nA]);
    const errY = (nearestY[nB] - nearestY[nA]) - (projY[nB] - projY[nA]);
    edgeCost += Math.sqrt(errX * errX + errY * errY) * invScale;
  }

  const duplicates = n - uniqueCount;
  return totalDist + edgeCost * 1.5 + duplicates * 0.3;
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
): number {
  if (scale <= 0) return 1e12;

  const n = anchorDx.length;
  const invScale = 1 / scale;
  let totalDist = 0;
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
      totalDist += d + d * d;
      nearestIdx[i] = nn.idx;
      nearestX[i] = nn.x;
      nearestY[i] = nn.y;
      if (usedGen[nn.idx] !== gen) {
        usedGen[nn.idx] = gen;
        uniqueCount++;
      }
    } else {
      totalDist += invScale + invScale * invScale;
      nearestIdx[i] = -1;
    }
  }

  let edgeCost = 0;
  for (let e = 0; e < edges.length; e++) {
    const nA = edges[e][0];
    const nB = edges[e][1];
    if (nearestIdx[nA] === -1 || nearestIdx[nB] === -1) {
      edgeCost += invScale;
      continue;
    }
    const errX = (nearestX[nB] - nearestX[nA]) - (projX[nB] - projX[nA]);
    const errY = (nearestY[nB] - nearestY[nA]) - (projY[nB] - projY[nA]);
    edgeCost += Math.sqrt(errX * errX + errY * errY) * invScale;
  }

  const duplicates = n - uniqueCount;
  return totalDist + edgeCost * 1.5 + duplicates * 0.3;
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
): { star: Star; nodeIndex: number }[] {
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
  return result;
}

// ---------------------------------------------------------------------------
// Main matching pipeline
// ---------------------------------------------------------------------------

export function matchStarsToAnchors(stars: Star[], graph: GlyphGraph): MatchResult {
  const { nodes, edges } = graph;

  if (nodes.length === 0 || stars.length === 0) {
    return { pairs: [], cost: Infinity, transform: { x: 0, y: 0, scale: 0 }, graph };
  }

  // --- Project stars to equirectangular 2D ---
  const eqStars: KDPoint[] = stars.map((s, i) => {
    const p = projectStarEq(s);
    return { x: p.x, y: p.y, idx: i };
  });

  const eqGrid = new StarGrid(eqStars);

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
  // Clamp y-range to ±65° declination for coarse search.
  // Gnomonic refinement handles the geometry correctly at any declination,
  // so we keep a wide coarse search range.
  const Y_MIN_CLAMP = 0.139;
  const Y_MAX_CLAMP = 0.861;
  let minSX = Infinity, maxSX = -Infinity;
  let minSY = Infinity, maxSY = -Infinity;
  for (const s of eqStars) {
    if (s.x < minSX) minSX = s.x;
    if (s.x > maxSX) maxSX = s.x;
    if (s.y < minSY) minSY = s.y;
    if (s.y > maxSY) maxSY = s.y;
  }
  minSY = Math.max(minSY, Y_MIN_CLAMP);
  maxSY = Math.min(maxSY, Y_MAX_CLAMP);

  // --- Coarse grid search in equirectangular space ---
  const posStepsX = 80;
  const posStepsY = 80;

  let anchorMinX = Infinity, anchorMaxX = -Infinity;
  for (let i = 0; i < n; i++) {
    if (anchorDx[i] < anchorMinX) anchorMinX = anchorDx[i];
    if (anchorDx[i] > anchorMaxX) anchorMaxX = anchorDx[i];
  }
  const anchorWidth = anchorMaxX - anchorMinX || 1;
  const maxAngularSpan = 0.139;
  const maxScale = maxAngularSpan / anchorWidth;
  const allScales = [0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.065, 0.08, 0.1, 0.13, 0.17, 0.22];
  const scaleValues = allScales.filter(s => s <= maxScale);
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

  const topN = 30;
  const best: Candidate[] = [];
  let worstBestCost = Infinity;

  const insertCandidate = (c: Candidate): void => {
    if (best.length < topN) {
      let lo = 0, hi = best.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (best[mid].cost < c.cost) lo = mid + 1;
        else hi = mid;
      }
      best.splice(lo, 0, c);
      if (best.length === topN) worstBestCost = best[topN - 1].cost;
    } else if (c.cost < worstBestCost) {
      let lo = 0, hi = topN - 1;
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

  for (let xi = 0; xi < posStepsX; xi++) {
    const tx = minSX + (rangeX * (xi + 0.5)) / posStepsX;
    for (let yi = 0; yi < posStepsY; yi++) {
      const ty = minSY + (rangeY * (yi + 0.5)) / posStepsY;
      for (const scale of scaleValues) {
        gen++;
        const cost = computeCostEq(eqGrid, anchorDx, anchorDy, edges, tx, ty, scale,
          projX, projY, nearestIdx, nearestXArr, nearestYArr, usedGen, gen, worstBestCost);
        insertCandidate({ tx, ty, scale, cost });
      }
    }
  }

  // =========================================================================
  // Phase 2: Gnomonic refinement of top candidates
  // =========================================================================

  // For each top candidate, project nearby stars onto a gnomonic tangent plane
  // centered at the candidate's equirectangular position, then run Nelder-Mead
  // in that locally-Euclidean space.

  let bestResult = { params: [0, 0, 0], cost: Infinity, ra0: 0, dec0: 0 };

  // Scratch arrays reusable across candidates (gnomonic cost fn uses same layout)
  const gnoProjX = new Float64Array(n);
  const gnoProjY = new Float64Array(n);
  const gnoNearIdx = new Int32Array(n);
  const gnoNearX = new Float64Array(n);
  const gnoNearY = new Float64Array(n);

  for (const candidate of best) {
    // Convert equirectangular center to spherical
    const ra0 = candidate.tx * 2 * Math.PI;
    const dec0 = candidate.ty * Math.PI - Math.PI / 2;
    const sinDec0 = Math.sin(dec0);
    const cosDec0 = Math.cos(dec0);

    // Project stars within ~40° angular distance onto the tangent plane
    const gnoPoints: KDPoint[] = [];
    const maxCosC = Math.cos(40 * Math.PI / 180); // ~0.766

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const cosDec = Math.cos(s.dec);
      const sinDec = Math.sin(s.dec);
      const cosDra = Math.cos(s.ra - ra0);
      const cosC = sinDec0 * sinDec + cosDec0 * cosDec * cosDra;
      if (cosC <= maxCosC) continue;

      const invCosC = 1 / cosC;
      const gx = cosDec * Math.sin(s.ra - ra0) * invCosC;
      const gy = (cosDec0 * sinDec - sinDec0 * cosDec * cosDra) * invCosC;
      gnoPoints.push({ x: gx, y: gy, idx: i });
    }

    if (gnoPoints.length < n) continue; // not enough nearby stars

    // Build spatial hash in gnomonic space
    // Stars within 40° → gnomonic coords up to tan(40°) ≈ 0.84
    // Average spacing ≈ 1.7 / sqrt(gnoPoints.length)
    const gnoCellSize = 1.7 / Math.sqrt(gnoPoints.length);
    const gnoGrid = new StarGrid(gnoPoints, gnoCellSize, 1.0);

    // Estimate initial gnomonic scale from equirectangular scale.
    // In equirectangular, vertical: Δdec = scale * dy * π
    // In gnomonic near center: Δy ≈ Δdec
    // So gnoScale ≈ scale * π
    const gnoScaleInit = candidate.scale * Math.PI;

    // Gnomonic used-gen tracking (reuse same array — star indices are global)
    const gnoUsedGen = usedGen; // reuse, gen counter keeps incrementing
    let gnoGen = gen;

    const costFn = (p: number[]): number => {
      gnoGen++;
      return computeCostGnomonic(gnoGrid, anchorDx, anchorDy, edges, p[0], p[1], p[2],
        gnoProjX, gnoProjY, gnoNearIdx, gnoNearX, gnoNearY, gnoUsedGen, gnoGen);
    };

    const optimized = nelderMead(
      costFn,
      [0, 0, gnoScaleInit],
      { tolerance: 1e-12, maxIterations: 2000, initialScale: 0.01 },
    );

    const cost = costFn(optimized);
    if (cost < bestResult.cost) {
      bestResult = { params: optimized, cost, ra0, dec0 };
    }

    gen = gnoGen; // keep gen counter in sync
  }

  // =========================================================================
  // Phase 3: Final pair assignment in gnomonic space
  // =========================================================================

  const { ra0, dec0 } = bestResult;
  const sinDec0 = Math.sin(dec0);
  const cosDec0 = Math.cos(dec0);
  const [offX, offY, gnoScale] = bestResult.params;

  // Project all stars to gnomonic space for final k-nearest assignment
  const gnoStarsFinal: KDPoint[] = [];
  const gnoStarPositions: Point2D[] = new Array(stars.length);
  for (let i = 0; i < stars.length; i++) {
    const gp = projectStarGnomonic(stars[i].ra, stars[i].dec, ra0, sinDec0, cosDec0);
    if (gp) {
      gnoStarsFinal.push({ x: gp.x, y: gp.y, idx: i });
      gnoStarPositions[i] = gp;
    }
  }

  // Project anchors in gnomonic space
  const finalProjected: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    finalProjected.push({
      x: offX - gnoScale * anchorDx[i],
      y: offY + gnoScale * anchorDy[i],
    });
  }

  const pairs = resolveDuplicates(
    gnoStarsFinal, gnoStarPositions, finalProjected, stars, nodes.length, edges,
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
    cost: bestResult.cost,
    transform: {
      x: normRa / (2 * Math.PI),
      y: (finalDec + Math.PI / 2) / Math.PI,
      scale: gnoScale,
    },
    graph,
  };
}
