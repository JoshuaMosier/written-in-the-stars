/**
 * Visualization script for written-in-the-stars.
 *
 * Generates a standalone HTML file that renders an equirectangular star map
 * with the matched constellation overlay.
 *
 * Usage:
 *   npx tsx scripts/visualize.ts "HELLO"
 */

import * as fs from 'fs';
import * as path from 'path';
import { textToGraph } from '../src/lib/engine/glyphs';
import { matchStarsToAnchors } from '../src/lib/engine/matcher';
import type { Star, MatchResult } from '../src/lib/engine/types';

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const starsPath = path.resolve(__dirname, '../static/stars.json');
const stars: Star[] = JSON.parse(fs.readFileSync(starsPath, 'utf-8'));

const text = process.argv[2] || 'HELLO';
const graph = textToGraph(text);

console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

// ---------------------------------------------------------------------------
// Run matcher
// ---------------------------------------------------------------------------

const matchResult = matchStarsToAnchors(stars, graph);
console.log(`Match cost: ${matchResult.cost}`);
console.log(
	`Transform: scale=${matchResult.transform.scale.toFixed(6)}, ` +
		`translate=(${matchResult.transform.x.toFixed(4)}, ${matchResult.transform.y.toFixed(4)})`,
);
console.log(`Matched ${matchResult.pairs.length} nodes to unique stars`);

// ---------------------------------------------------------------------------
// Build HTML
// ---------------------------------------------------------------------------

const starsJson = JSON.stringify(stars.map((s) => ({ id: s.id, ra: s.ra, dec: s.dec, mag: s.mag, name: s.name })));
const matchJson = JSON.stringify(matchResult);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Star Match – ${text}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a14; color: #ccc; font-family: 'Segoe UI', sans-serif; overflow: hidden; }
  #title {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    font-size: 22px; letter-spacing: 4px; color: #ffe680; text-shadow: 0 0 12px #ffd700aa;
    z-index: 10; pointer-events: none;
  }
  #info {
    position: absolute; bottom: 12px; left: 16px; font-size: 12px; color: #888;
    z-index: 10; pointer-events: none;
  }
  canvas { display: block; }
  #container { display: flex; width: 100vw; height: 100vh; }
  #main-canvas { flex: 3; }
  #mini-canvas { flex: 1; border-left: 1px solid #333; }
</style>
</head>
<body>
<div id="title">${text}</div>
<div id="info"></div>
<div id="container">
  <canvas id="main-canvas"></canvas>
  <canvas id="mini-canvas"></canvas>
</div>
<script>
// ---- Data injected from Node -------------------------------------------
const stars = ${starsJson};
const matchResult = ${matchJson};

// ---- Helpers ------------------------------------------------------------

function starRadius(mag) {
  return Math.max(0.4, 3.2 - mag * 0.4);
}

function starOpacity(mag) {
  return Math.min(1, Math.max(0.12, 1.0 - mag / 8));
}

// ---- Build lookup from nodeIndex -> star --------------------------------

const nodeToStar = new Map();
const matchedStarIds = new Set();
if (matchResult) {
  for (const p of matchResult.pairs) {
    nodeToStar.set(p.nodeIndex, p.star);
    matchedStarIds.add(p.star.id);
  }
}

// ---- Compute bounding box of matched region (RA/Dec) --------------------

let regionRA0 = 0, regionRA1 = 2 * Math.PI;
let regionDec0 = -Math.PI / 2, regionDec1 = Math.PI / 2;

if (matchResult && matchResult.pairs.length > 0) {
  let minRA = Infinity, maxRA = -Infinity;
  let minDec = Infinity, maxDec = -Infinity;
  for (const p of matchResult.pairs) {
    const s = p.star;
    if (s.ra < minRA) minRA = s.ra;
    if (s.ra > maxRA) maxRA = s.ra;
    if (s.dec < minDec) minDec = s.dec;
    if (s.dec > maxDec) maxDec = s.dec;
  }
  const padRA = (maxRA - minRA) * 0.35 + 0.05;
  const padDec = (maxDec - minDec) * 0.35 + 0.05;
  regionRA0 = minRA - padRA;
  regionRA1 = maxRA + padRA;
  regionDec0 = minDec - padDec;
  regionDec1 = maxDec + padDec;
}

// ---- Drawing functions --------------------------------------------------

function drawStarField(ctx, w, h, mapRA0, mapRA1, mapDec0, mapDec1, highlightMatched) {
  const raRange = mapRA1 - mapRA0;
  const decRange = mapDec1 - mapDec0;

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0d0d1a');
  grad.addColorStop(0.5, '#0a0a14');
  grad.addColorStop(1, '#0d0d1a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Draw grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 0.5;
  const raStep = raRange > 1 ? Math.PI / 6 : raRange / 6;
  const decStep = decRange > 0.5 ? Math.PI / 12 : decRange / 6;
  for (let ra = Math.ceil(mapRA0 / raStep) * raStep; ra <= mapRA1; ra += raStep) {
    const x = ((ra - mapRA0) / raRange) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let dec = Math.ceil(mapDec0 / decStep) * decStep; dec <= mapDec1; dec += decStep) {
    const y = ((mapDec1 - dec) / decRange) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Draw stars
  for (const s of stars) {
    if (s.ra < mapRA0 || s.ra > mapRA1) continue;
    if (s.dec < mapDec0 || s.dec > mapDec1) continue;

    const x = ((s.ra - mapRA0) / raRange) * w;
    const y = ((mapDec1 - s.dec) / decRange) * h;
    const r = starRadius(s.mag);
    const alpha = starOpacity(s.mag);
    const isMatched = highlightMatched && matchedStarIds.has(s.id);

    if (isMatched) {
      // Glow
      ctx.beginPath();
      ctx.arc(x, y, r * 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 215, 0, 0.15)';
      ctx.fill();
      // Star
      ctx.beginPath();
      ctx.arc(x, y, r * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 215, 0, 1)';
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r * (highlightMatched ? 0.7 : 1), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 210, 255,' + alpha + ')';
      ctx.fill();
    }
  }

  // Draw constellation edges from graph
  if (highlightMatched && matchResult && matchResult.graph) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 180, 50, 0.7)';
    for (const [nA, nB] of matchResult.graph.edges) {
      const starA = nodeToStar.get(nA);
      const starB = nodeToStar.get(nB);
      if (!starA || !starB) continue;

      const x1 = ((starA.ra - mapRA0) / raRange) * w;
      const y1 = ((mapDec1 - starA.dec) / decRange) * h;
      const x2 = ((starB.ra - mapRA0) / raRange) * w;
      const y2 = ((mapDec1 - starB.dec) / decRange) * h;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Draw star names for matched stars
  if (highlightMatched && matchResult) {
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255, 230, 150, 0.8)';
    ctx.textBaseline = 'bottom';
    for (const p of matchResult.pairs) {
      if (p.star.name) {
        const x = ((p.star.ra - mapRA0) / raRange) * w;
        const y = ((mapDec1 - p.star.dec) / decRange) * h;
        ctx.fillText(p.star.name, x + 5, y - 3);
      }
    }
  }
}

// ---- Canvas setup -------------------------------------------------------

const container = document.getElementById('container');
const mainCanvas = document.getElementById('main-canvas');
const miniCanvas = document.getElementById('mini-canvas');
const mainCtx = mainCanvas.getContext('2d');
const miniCtx = miniCanvas.getContext('2d');
const info = document.getElementById('info');

function resize() {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const mainW = Math.floor(cw * 0.75);
  const miniW = cw - mainW;

  mainCanvas.width = mainW;
  mainCanvas.height = ch;
  mainCanvas.style.width = mainW + 'px';
  mainCanvas.style.height = ch + 'px';

  miniCanvas.width = miniW;
  miniCanvas.height = ch;
  miniCanvas.style.width = miniW + 'px';
  miniCanvas.style.height = ch + 'px';

  draw();
}

function draw() {
  // Main view: zoomed into matched region
  drawStarField(mainCtx, mainCanvas.width, mainCanvas.height,
    regionRA0, regionRA1, regionDec0, regionDec1, true);

  mainCtx.font = '11px monospace';
  mainCtx.fillStyle = '#666';
  mainCtx.fillText('Zoomed Match Region', 10, mainCanvas.height - 10);

  // Mini view: full sky with region box
  drawStarField(miniCtx, miniCanvas.width, miniCanvas.height,
    0, 2 * Math.PI, -Math.PI / 2, Math.PI / 2, true);

  if (matchResult) {
    const mw = miniCanvas.width;
    const mh = miniCanvas.height;
    const x0 = (regionRA0 / (2 * Math.PI)) * mw;
    const x1 = (regionRA1 / (2 * Math.PI)) * mw;
    const y0 = ((Math.PI / 2 - regionDec1) / Math.PI) * mh;
    const y1 = ((Math.PI / 2 - regionDec0) / Math.PI) * mh;
    miniCtx.strokeStyle = 'rgba(255, 215, 0, 0.6)';
    miniCtx.lineWidth = 1.5;
    miniCtx.setLineDash([4, 4]);
    miniCtx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    miniCtx.setLineDash([]);
  }

  miniCtx.font = '11px monospace';
  miniCtx.fillStyle = '#666';
  miniCtx.fillText('Full Sky', 10, miniCanvas.height - 10);

  // Info text
  const infoLines = [
    'Stars: ' + stars.length,
    'Nodes: ' + (matchResult?.graph?.nodes?.length ?? 0),
    'Edges: ' + (matchResult?.graph?.edges?.length ?? 0),
    'Matched: ' + (matchResult?.pairs?.length ?? 0) + ' stars',
    'Cost: ' + (matchResult?.cost?.toFixed(4) ?? 'N/A'),
  ];
  info.textContent = infoLines.join('  |  ');
}

window.addEventListener('resize', resize);
resize();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) {
	fs.mkdirSync(outDir, { recursive: true });
}

const outPath = path.join(outDir, 'result.html');
fs.writeFileSync(outPath, html, 'utf-8');
console.log(`\nVisualization written to: ${outPath}`);
console.log(`Open in a browser to view the star map.`);
