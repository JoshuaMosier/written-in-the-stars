/**
 * Sweep search parameters to find cost vs time tradeoffs.
 * Tests grid size, candidate count, NM iterations, and scale granularity.
 * Uses the equirectangular coarse search only (to isolate grid search impact).
 */
import { textToGraph } from '../src/lib/engine/glyphs';
import * as fs from 'fs';

// @ts-ignore
import kdTreePkg from 'kd-tree-javascript';
const { kdTree } = kdTreePkg;
import { nelderMead } from '../src/lib/engine/optimizer';
import type { Star, AnchorPoint, GlyphGraph } from '../src/lib/engine/types';

const stars: Star[] = JSON.parse(fs.readFileSync('src/lib/data/stars.json', 'utf-8'));

interface Point2D { x: number; y: number }
interface KDPoint { x: number; y: number; idx: number }

function projectStar(s: Star): Point2D {
  return { x: s.ra / (2 * Math.PI), y: (s.dec + Math.PI / 2) / Math.PI };
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
    const inv = this.invCellSize, cs = this.cellSize, pad = this.pad;
    const gw = this.gridW, gh = this.gridH;
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
          const cx = qcx + dx, cy = qcy + dy;
          if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
          const cell = this.cells[cy * gw + cx];
          if (!cell) continue;
          for (let i = 0; i < cell.length; i++) {
            const p = cell[i];
            const ddx = p.x - qx, ddy = p.y - qy;
            const d = ddx * ddx + ddy * ddy;
            if (d < bestDistSq) { bestDistSq = d; bestPoint = p; }
          }
        }
      }
    }
    this.lastDistSq = bestDistSq;
    return bestPoint;
  }
}

function computeCostEq(
  grid: StarGrid, anchorDx: Float64Array, anchorDy: Float64Array,
  edges: [number, number][], tx: number, ty: number, scale: number,
  projX: Float64Array, projY: Float64Array,
  nearestIdx: Int32Array, nearestX: Float64Array, nearestY: Float64Array,
  usedGen: Uint32Array, gen: number, costCeiling: number,
): number {
  if (scale <= 0) return 1e12;
  const n = anchorDx.length, invScale = 1 / scale;
  let totalDist = 0, uniqueCount = 0;
  for (let i = 0; i < n; i++) {
    const pointY = ty + scale * anchorDy[i];
    const pointDec = pointY * Math.PI - Math.PI / 2;
    const cosDec = Math.cos(pointDec);
    const xStretch = Math.min(2.5, cosDec > 0.1 ? 1 / cosDec : 2.5);
    const px = tx - scale * anchorDx[i] * xStretch;
    projX[i] = px; projY[i] = pointY;
    const nn = grid.nearest1WithDist(px, pointY);
    if (nn) {
      const d = Math.sqrt(grid.lastDistSq) * invScale;
      totalDist += d + d * d;
      nearestIdx[i] = nn.idx; nearestX[i] = nn.x; nearestY[i] = nn.y;
      if (usedGen[nn.idx] !== gen) { usedGen[nn.idx] = gen; uniqueCount++; }
    } else { totalDist += invScale + invScale * invScale; nearestIdx[i] = -1; }
    if (totalDist > costCeiling) return totalDist;
  }
  let edgeCost = 0;
  for (let e = 0; e < edges.length; e++) {
    const nA = edges[e][0], nB = edges[e][1];
    if (nearestIdx[nA] === -1 || nearestIdx[nB] === -1) { edgeCost += invScale; continue; }
    const errX = (nearestX[nB] - nearestX[nA]) - (projX[nB] - projX[nA]);
    const errY = (nearestY[nB] - nearestY[nA]) - (projY[nB] - projY[nA]);
    edgeCost += Math.sqrt(errX * errX + errY * errY) * invScale;
  }
  const duplicates = n - uniqueCount;
  return totalDist + edgeCost * 1.5 + duplicates * 0.3;
}

// Gnomonic helpers
function computeCostGnomonic(
  grid: StarGrid, anchorDx: Float64Array, anchorDy: Float64Array,
  edges: [number, number][], offX: number, offY: number, scale: number,
  projX: Float64Array, projY: Float64Array,
  nearestIdx: Int32Array, nearestX: Float64Array, nearestY: Float64Array,
  usedGen: Uint32Array, gen: number,
): number {
  if (scale <= 0) return 1e12;
  const n = anchorDx.length, invScale = 1 / scale;
  let totalDist = 0, uniqueCount = 0;
  for (let i = 0; i < n; i++) {
    const px = offX - scale * anchorDx[i];
    const py = offY + scale * anchorDy[i];
    projX[i] = px; projY[i] = py;
    const nn = grid.nearest1WithDist(px, py);
    if (nn) {
      const d = Math.sqrt(grid.lastDistSq) * invScale;
      totalDist += d + d * d;
      nearestIdx[i] = nn.idx; nearestX[i] = nn.x; nearestY[i] = nn.y;
      if (usedGen[nn.idx] !== gen) { usedGen[nn.idx] = gen; uniqueCount++; }
    } else { totalDist += invScale + invScale * invScale; nearestIdx[i] = -1; }
  }
  let edgeCost = 0;
  for (let e = 0; e < edges.length; e++) {
    const nA = edges[e][0], nB = edges[e][1];
    if (nearestIdx[nA] === -1 || nearestIdx[nB] === -1) { edgeCost += invScale; continue; }
    const errX = (nearestX[nB] - nearestX[nA]) - (projX[nB] - projX[nA]);
    const errY = (nearestY[nB] - nearestY[nA]) - (projY[nB] - projY[nA]);
    edgeCost += Math.sqrt(errX * errX + errY * errY) * invScale;
  }
  const duplicates = n - uniqueCount;
  return totalDist + edgeCost * 1.5 + duplicates * 0.3;
}

interface Config {
  label: string;
  gridSteps: number;
  scales: number[];
  topN: number;
  nmIter: number;
}

const SPARSE_SCALES = [0.02, 0.03, 0.05, 0.08, 0.13, 0.22];
const BASE_SCALES = [0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.065, 0.08, 0.1, 0.13, 0.17, 0.22];
const DENSE_SCALES = [0.012, 0.015, 0.018, 0.02, 0.023, 0.025, 0.03, 0.035, 0.04, 0.05, 0.065, 0.08, 0.1, 0.13, 0.17, 0.22];

const configs: Config[] = [
  { label: 'current (50×50, 6sc, top30)',    gridSteps: 50,  scales: SPARSE_SCALES, topN: 30,  nmIter: 2000 },
  { label: '80×80, 12sc, top30',             gridSteps: 80,  scales: BASE_SCALES,   topN: 30,  nmIter: 2000 },
  { label: '80×80, 12sc, top60',             gridSteps: 80,  scales: BASE_SCALES,   topN: 60,  nmIter: 2000 },
  { label: '100×100, 12sc, top30',           gridSteps: 100, scales: BASE_SCALES,   topN: 30,  nmIter: 2000 },
  { label: '100×100, 16sc, top60',           gridSteps: 100, scales: DENSE_SCALES,  topN: 60,  nmIter: 2000 },
  { label: '120×120, 12sc, top30',           gridSteps: 120, scales: BASE_SCALES,   topN: 30,  nmIter: 2000 },
  { label: '120×120, 16sc, top60',           gridSteps: 120, scales: DENSE_SCALES,  topN: 60,  nmIter: 2000 },
  { label: '80×80, 12sc, top30, NM4000',     gridSteps: 80,  scales: BASE_SCALES,   topN: 30,  nmIter: 4000 },
];

const testWords = ['STAR', 'HELLO', 'CONSTELLATION'];

// Pre-build shared structures
const eqStars: KDPoint[] = stars.map((s: Star, i: number) => {
  const p = projectStar(s);
  return { x: p.x, y: p.y, idx: i };
});
const eqGrid = new StarGrid(eqStars);

let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
for (const s of eqStars) {
  if (s.x < minSX) minSX = s.x; if (s.x > maxSX) maxSX = s.x;
  if (s.y < minSY) minSY = s.y; if (s.y > maxSY) maxSY = s.y;
}
minSY = Math.max(minSY, 0.139);
maxSY = Math.min(maxSY, 0.861);

function runConfig(config: Config, graph: GlyphGraph): { cost: number; ms: number } {
  const { nodes, edges } = graph;
  const n = nodes.length;

  let cx = 0, cy = 0;
  for (const a of nodes) { cx += a.x; cy += a.y; }
  cx /= n; cy /= n;

  const anchorDx = new Float64Array(n);
  const anchorDy = new Float64Array(n);
  for (let i = 0; i < n; i++) { anchorDx[i] = nodes[i].x - cx; anchorDy[i] = nodes[i].y - cy; }

  let aMinX = Infinity, aMaxX = -Infinity;
  for (let i = 0; i < n; i++) { if (anchorDx[i] < aMinX) aMinX = anchorDx[i]; if (anchorDx[i] > aMaxX) aMaxX = anchorDx[i]; }
  const anchorWidth = aMaxX - aMinX || 1;
  const maxScale = 0.139 / anchorWidth;
  const scaleValues = config.scales.filter(s => s <= maxScale);
  if (scaleValues.length < 3) {
    for (const s of config.scales) {
      if (!scaleValues.includes(s)) scaleValues.push(s);
      if (scaleValues.length >= 3) break;
    }
    scaleValues.sort((a, b) => a - b);
  }

  const rangeX = maxSX - minSX || 1;
  const rangeY = maxSY - minSY || 1;
  const { gridSteps, topN, nmIter } = config;

  const projX = new Float64Array(n), projY = new Float64Array(n);
  const nearestIdx = new Int32Array(n), nearestXArr = new Float64Array(n), nearestYArr = new Float64Array(n);
  const usedGen = new Uint32Array(stars.length);
  let gen = 0;

  const best: { tx: number; ty: number; scale: number; cost: number }[] = [];
  let worstBestCost = Infinity;

  const t0 = performance.now();

  // Coarse EQ grid search
  for (let xi = 0; xi < gridSteps; xi++) {
    const tx = minSX + (rangeX * (xi + 0.5)) / gridSteps;
    for (let yi = 0; yi < gridSteps; yi++) {
      const ty = minSY + (rangeY * (yi + 0.5)) / gridSteps;
      for (const scale of scaleValues) {
        gen++;
        const cost = computeCostEq(eqGrid, anchorDx, anchorDy, edges, tx, ty, scale,
          projX, projY, nearestIdx, nearestXArr, nearestYArr, usedGen, gen, worstBestCost);
        if (best.length < topN) {
          let lo = 0, hi = best.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (best[mid].cost < cost) lo = mid + 1; else hi = mid; }
          best.splice(lo, 0, { tx, ty, scale, cost });
          if (best.length === topN) worstBestCost = best[topN - 1].cost;
        } else if (cost < worstBestCost) {
          let lo = 0, hi = topN - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (best[mid].cost < cost) lo = mid + 1; else hi = mid; }
          best.splice(lo, 0, { tx, ty, scale, cost });
          best.length = topN;
          worstBestCost = best[topN - 1].cost;
        }
      }
    }
  }

  // Gnomonic NM refinement
  let bestResult = { params: [0, 0, 0], cost: Infinity };
  const maxCosC = Math.cos(40 * Math.PI / 180);
  const gnoProjX = new Float64Array(n), gnoProjY = new Float64Array(n);
  const gnoNearIdx = new Int32Array(n), gnoNearX = new Float64Array(n), gnoNearY = new Float64Array(n);

  for (const cand of best) {
    const ra0 = cand.tx * 2 * Math.PI;
    const dec0 = cand.ty * Math.PI - Math.PI / 2;
    const sinDec0 = Math.sin(dec0), cosDec0 = Math.cos(dec0);

    const gnoPoints: KDPoint[] = [];
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const cosDec = Math.cos(s.dec), sinDec = Math.sin(s.dec);
      const cosDra = Math.cos(s.ra - ra0);
      const cosC = sinDec0 * sinDec + cosDec0 * cosDec * cosDra;
      if (cosC <= maxCosC) continue;
      const invCosC = 1 / cosC;
      gnoPoints.push({ x: cosDec * Math.sin(s.ra - ra0) * invCosC, y: (cosDec0 * sinDec - sinDec0 * cosDec * cosDra) * invCosC, idx: i });
    }
    if (gnoPoints.length < n) continue;

    const gnoCellSize = 1.7 / Math.sqrt(gnoPoints.length);
    const gnoGrid = new StarGrid(gnoPoints, gnoCellSize, 1.0);
    const gnoScaleInit = cand.scale * Math.PI;

    const costFn = (p: number[]): number => {
      gen++;
      return computeCostGnomonic(gnoGrid, anchorDx, anchorDy, edges, p[0], p[1], p[2],
        gnoProjX, gnoProjY, gnoNearIdx, gnoNearX, gnoNearY, usedGen, gen);
    };

    const optimized = nelderMead(costFn, [0, 0, gnoScaleInit],
      { tolerance: 1e-12, maxIterations: nmIter, initialScale: 0.01 });
    const cost = costFn(optimized);
    if (cost < bestResult.cost) bestResult = { params: optimized, cost };
  }

  const ms = performance.now() - t0;
  return { cost: bestResult.cost, ms };
}

// Run sweep
console.log('Parameter sweep — coarse EQ grid + gnomonic NM refinement\n');
console.log('Config'.padEnd(40) + testWords.map(w => w.padStart(24)).join(''));
console.log('-'.repeat(40 + testWords.length * 24));

for (const config of configs) {
  const results: string[] = [];
  for (const word of testWords) {
    const graph = textToGraph(word);
    const { cost, ms } = runConfig(config, graph);
    results.push(`${cost.toFixed(4)} (${ms.toFixed(0)}ms)`);
  }
  console.log(config.label.padEnd(40) + results.map(r => r.padStart(24)).join(''));
}
