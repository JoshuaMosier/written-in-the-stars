/**
 * Core matching pipeline: finds the best placement of glyph graph nodes onto
 * a star field by searching over (x, y, scale) transforms.
 *
 * Stars are projected to 2D via equirectangular projection (x = ra, y = dec)
 * and a KD-tree is used for efficient nearest-neighbour lookups.
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
 * Project a star to a 2D working coordinate space via equirectangular
 * projection.  RA  [0, 2π] -> [0, 1],  Dec [-π/2, π/2] -> [0, 1].
 */
function projectStar(star: Star): Point2D {
  return {
    x: star.ra / (2 * Math.PI),
    y: (star.dec + Math.PI / 2) / Math.PI,
  };
}

/** Euclidean distance in 2D. */
function dist2D(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Transform application
// ---------------------------------------------------------------------------

/**
 * Apply a (tx, ty, scale) transform to anchor points, mapping them
 * from their normalized [0,1] space into the projected star space.
 *
 * Anchors are first centered around their own centroid, then scaled
 * and translated. Applies per-point cos(dec) correction so text maintains
 * proper aspect ratio without curving — each point is stretched according
 * to its own declination, not just the center's.
 */
function transformAnchors(
  anchors: AnchorPoint[],
  centroidX: number,
  centroidY: number,
  tx: number,
  ty: number,
  scale: number,
): Point2D[] {
  return anchors.map((a) => {
    const dx = a.x - centroidX;
    const dy = a.y - centroidY;
    const pointY = ty + scale * dy;
    // Compute per-point declination correction so text doesn't curve near poles.
    // y = (dec + π/2) / π → dec = y·π - π/2
    const pointDec = pointY * Math.PI - Math.PI / 2;
    const cosDec = Math.cos(pointDec);
    const xStretch = Math.min(2.5, cosDec > 0.1 ? 1 / cosDec : 2.5);
    return {
      x: tx - scale * dx * xStretch, // Flip x + equirectangular correction
      y: pointY,
    };
  });
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

interface KDPoint {
  x: number;
  y: number;
  idx: number;
}

/**
 * Compute the total cost for a given transform. Combines:
 *  1) Node distance: how far each anchor's nearest star is from the ideal position
 *  2) Edge distortion: how much connected node pairs deviate from expected relative positions
 *  3) Duplicate penalty: discourages multiple anchors mapping to the same star
 */
function computeCost(
  tree: kdTree<KDPoint>,
  anchors: AnchorPoint[],
  edges: [number, number][],
  centroidX: number,
  centroidY: number,
  tx: number,
  ty: number,
  scale: number,
): number {
  // Penalize non-positive scales heavily
  if (scale <= 0) return 1e12;

  const projected = transformAnchors(anchors, centroidX, centroidY, tx, ty, scale);
  let totalDist = 0;
  const usedStars = new Set<number>();
  const nearestStars: KDPoint[] = new Array(anchors.length);

  for (let i = 0; i < projected.length; i++) {
    const nearest = tree.nearest(projected[i] as KDPoint, 1);
    if (nearest.length > 0) {
      totalDist += nearest[0][1] / scale;
      usedStars.add(nearest[0][0].idx);
      nearestStars[i] = nearest[0][0];
    } else {
      totalDist += 1 / scale;
    }
  }

  // Edge distortion: for each edge, compare the actual star-to-star vector
  // against the expected anchor-to-anchor vector
  let edgeCost = 0;
  for (const [nA, nB] of edges) {
    const starA = nearestStars[nA];
    const starB = nearestStars[nB];
    if (!starA || !starB) {
      edgeCost += 1 / scale;
      continue;
    }
    // Expected vector between anchors (in projected space)
    const expectedDx = projected[nB].x - projected[nA].x;
    const expectedDy = projected[nB].y - projected[nA].y;
    // Actual vector between nearest stars
    const actualDx = starB.x - starA.x;
    const actualDy = starB.y - starA.y;
    // Vector difference normalized by scale
    const errX = actualDx - expectedDx;
    const errY = actualDy - expectedDy;
    edgeCost += Math.sqrt(errX * errX + errY * errY) / scale;
  }

  // Penalize duplicate star assignments
  const duplicates = anchors.length - usedStars.size;
  const dupPenalty = duplicates * 0.3;

  return totalDist + edgeCost * 0.5 + dupPenalty;
}

// ---------------------------------------------------------------------------
// Duplicate resolution
// ---------------------------------------------------------------------------

/**
 * Given matched pairs, resolve cases where multiple anchors map to the same
 * star using greedy assignment + iterative swap refinement.
 *
 * After the initial greedy pass, iteratively tries swapping assignments
 * between nodes to reduce edge distortion — this fixes cases where the
 * greedy order causes cascading bad assignments.
 */
function resolveDuplicates(
  tree: kdTree<KDPoint>,
  projected: Point2D[],
  stars: Star[],
  nodeCount: number,
  edges: [number, number][],
): { star: Star; nodeIndex: number }[] {
  const k = Math.min(50, stars.length);
  const projStars = stars.map((s) => projectStar(s));

  // For each node, get its k nearest stars with distances
  const candidates: { starIdx: number; dist: number }[][] = projected.map((p) => {
    const nearest = tree.nearest(p as KDPoint, k);
    return nearest.map((n: [KDPoint, number]) => ({ starIdx: n[0].idx, dist: n[1] }));
  });

  // Build adjacency list for quick edge lookups
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

  const assignment: number[] = new Array(nodeCount).fill(-1); // nodeIdx -> starIdx
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
    // Fallback: if all k candidates taken, use nearest anyway
    if (assignment[nodeIdx] === -1 && cands.length > 0) {
      assignment[nodeIdx] = cands[0].starIdx;
    }
  }

  // --- Phase 2: Iterative swap refinement ---
  // Compute edge distortion cost for a node given current assignments
  const nodeEdgeCost = (nodeIdx: number): number => {
    let cost = 0;
    const starPos = projStars[assignment[nodeIdx]];
    for (const neighbor of adjacency[nodeIdx]) {
      if (assignment[neighbor] === -1) continue;
      const neighborStarPos = projStars[assignment[neighbor]];
      const expectedDx = projected[neighbor].x - projected[nodeIdx].x;
      const expectedDy = projected[neighbor].y - projected[nodeIdx].y;
      const actualDx = neighborStarPos.x - starPos.x;
      const actualDy = neighborStarPos.y - starPos.y;
      const errX = actualDx - expectedDx;
      const errY = actualDy - expectedDy;
      cost += Math.sqrt(errX * errX + errY * errY);
    }
    // Add proximity cost (distance from ideal position)
    const dx = starPos.x - projected[nodeIdx].x;
    const dy = starPos.y - projected[nodeIdx].y;
    cost += Math.sqrt(dx * dx + dy * dy);
    return cost;
  };

  // Try swapping each node's star with alternatives from its candidate list
  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let improved = false;

    for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) {
      const currentStar = assignment[nodeIdx];
      const currentNodeCost = nodeEdgeCost(nodeIdx);
      let bestImprovement = 0;
      let bestStar = currentStar;
      let bestSwapNode = -1; // node to swap with, or -1 if star is unused

      for (const c of candidates[nodeIdx]) {
        if (c.starIdx === currentStar) continue;

        // Find who currently owns this star
        const ownerNode = assignment.indexOf(c.starIdx);

        if (ownerNode === -1) {
          // Star is unused — try direct reassignment
          assignment[nodeIdx] = c.starIdx;
          const improvement = currentNodeCost - nodeEdgeCost(nodeIdx);
          if (improvement > bestImprovement) {
            bestImprovement = improvement;
            bestStar = c.starIdx;
            bestSwapNode = -1;
          }
          assignment[nodeIdx] = currentStar;
        } else {
          // Star is owned — try swap: give owner our star, take theirs
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
          // Undo
          assignment[nodeIdx] = currentStar;
          assignment[ownerNode] = c.starIdx;
        }
      }

      if (bestStar !== currentStar) {
        if (bestSwapNode === -1) {
          usedStars.delete(currentStar);
          usedStars.add(bestStar);
          assignment[nodeIdx] = bestStar;
        } else {
          assignment[nodeIdx] = bestStar;
          assignment[bestSwapNode] = currentStar;
        }
        improved = true;
      }
    }

    if (!improved) break;
  }

  // Build result
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

  // --- Project stars to 2D and build KD-tree ---
  const projectedStars: KDPoint[] = stars.map((s, i) => {
    const p = projectStar(s);
    return { x: p.x, y: p.y, idx: i };
  });

  const tree = new kdTree<KDPoint>(
    projectedStars,
    (a: KDPoint, b: KDPoint) => dist2D(a, b),
    ['x', 'y'],
  );

  // --- Compute node centroid ---
  let cx = 0;
  let cy = 0;
  for (const a of nodes) {
    cx += a.x;
    cy += a.y;
  }
  cx /= nodes.length;
  cy /= nodes.length;

  // --- Compute projected star field extent ---
  // Clamp y-range to ±65° declination to avoid polar wrapping.
  // dec=±65° → y = (±65·π/180 + π/2) / π ≈ 0.139 / 0.861
  const Y_MIN_CLAMP = 0.139;
  const Y_MAX_CLAMP = 0.861;
  let minSX = Infinity, maxSX = -Infinity;
  let minSY = Infinity, maxSY = -Infinity;
  for (const s of projectedStars) {
    if (s.x < minSX) minSX = s.x;
    if (s.x > maxSX) maxSX = s.x;
    if (s.y < minSY) minSY = s.y;
    if (s.y > maxSY) maxSY = s.y;
  }
  minSY = Math.max(minSY, Y_MIN_CLAMP);
  maxSY = Math.min(maxSY, Y_MAX_CLAMP);

  // --- Coarse grid search (no rotation) ---
  const posStepsX = 80;
  const posStepsY = 80;

  // Compute anchor bounding box width to limit max scale.
  // On a sphere, text spanning too many degrees of RA curves visibly.
  // Cap so the text subtends at most ~50° (≈0.139 in normalized RA space).
  let anchorMinX = Infinity, anchorMaxX = -Infinity;
  for (const a of nodes) {
    const dx = a.x - cx;
    if (dx < anchorMinX) anchorMinX = dx;
    if (dx > anchorMaxX) anchorMaxX = dx;
  }
  const anchorWidth = anchorMaxX - anchorMinX || 1;
  const maxAngularSpan = 0.139; // ~50° in normalized RA
  const maxScale = maxAngularSpan / anchorWidth;
  const allScales = [0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.065, 0.08, 0.1, 0.13, 0.17, 0.22];
  const scaleValues = allScales.filter(s => s <= maxScale);
  // Ensure at least the smallest scales are always available
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

  const insertCandidate = (c: Candidate): void => {
    if (best.length < topN) {
      best.push(c);
      best.sort((a, b) => a.cost - b.cost);
    } else if (c.cost < best[topN - 1].cost) {
      best[topN - 1] = c;
      best.sort((a, b) => a.cost - b.cost);
    }
  };

  for (let xi = 0; xi < posStepsX; xi++) {
    const tx = minSX + (rangeX * (xi + 0.5)) / posStepsX;
    for (let yi = 0; yi < posStepsY; yi++) {
      const ty = minSY + (rangeY * (yi + 0.5)) / posStepsY;
      for (const scale of scaleValues) {
        const cost = computeCost(tree, nodes, edges, cx, cy, tx, ty, scale);
        insertCandidate({ tx, ty, scale, cost });
      }
    }
  }

  // --- Fine refinement with Nelder-Mead on top candidates (3 params: x, y, scale) ---
  let bestResult: { params: number[]; cost: number } = { params: [0, 0, 0], cost: Infinity };

  for (const candidate of best) {
    const costFn = (p: number[]): number =>
      computeCost(tree, nodes, edges, cx, cy, p[0], p[1], p[2]);

    const optimized = nelderMead(
      costFn,
      [candidate.tx, candidate.ty, candidate.scale],
      { tolerance: 1e-12, maxIterations: 2000, initialScale: 0.01 },
    );

    const cost = costFn(optimized);
    if (cost < bestResult.cost) {
      bestResult = { params: optimized, cost };
    }
  }

  const [tx, ty, scale] = bestResult.params;

  const finalProjected = transformAnchors(nodes, cx, cy, tx, ty, scale);

  // --- Build final pairs with duplicate resolution + swap refinement ---
  const pairs = resolveDuplicates(tree, finalProjected, stars, nodes.length, edges);

  return {
    pairs,
    cost: bestResult.cost,
    transform: { x: tx, y: ty, scale },
    graph,
  };
}
