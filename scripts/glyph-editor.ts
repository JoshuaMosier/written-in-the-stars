/**
 * Interactive glyph editor for tweaking Hershey Simplex letter shapes.
 *
 * Generates a standalone HTML file with a visual editor that lets you:
 *   - Pick any glyph from the font
 *   - See its stroke data as nodes and edges
 *   - Click nodes to delete them
 *   - Click edges to add new nodes
 *   - Drag nodes to reposition them
 *   - Copy the resulting data array back into glyphs.ts
 *
 * Usage:
 *   npx tsx scripts/glyph-editor.ts
 *   (then open the generated HTML in a browser)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Extract GLYPHS data from the actual glyphs.ts source file
// ---------------------------------------------------------------------------
const glyphsSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/lib/engine/glyphs.ts'),
  'utf-8',
);

// Pull out just the GLYPHS object literal (from the opening `{` to its closing `};`)
const objStart = glyphsSrc.indexOf('= {', glyphsSrc.indexOf('const GLYPHS'));
if (objStart === -1) throw new Error('Could not find GLYPHS object in glyphs.ts');
let braceDepth = 0;
let objEnd = -1;
for (let i = objStart + 2; i < glyphsSrc.length; i++) {
  if (glyphsSrc[i] === '{') braceDepth++;
  else if (glyphsSrc[i] === '}') {
    braceDepth--;
    if (braceDepth === 0) { objEnd = i + 1; break; }
  }
}
if (objEnd === -1) throw new Error('Could not find end of GLYPHS object');

// Strip TypeScript type annotations (Record<string, GlyphDef>) — the raw object is valid JS
const glyphsObjSource = glyphsSrc.slice(objStart + 2, objEnd);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Glyph Editor – Written in the Stars</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #111; color: #ccc; font-family: 'Segoe UI', Consolas, monospace;
    display: flex; height: 100vh; overflow: hidden;
  }

  .sidebar {
    width: 320px; min-width: 320px; background: #1a1a1a; border-right: 1px solid #333;
    display: flex; flex-direction: column; overflow: hidden;
  }

  .sidebar h2 { padding: 16px; font-size: 14px; letter-spacing: 2px; color: #ffd700; text-transform: uppercase; }

  .glyph-grid {
    display: flex; flex-wrap: wrap; gap: 2px; padding: 0 12px 12px;
    overflow-y: auto; max-height: 160px;
  }
  .glyph-btn {
    width: 36px; height: 36px; background: #222; border: 1px solid #333; border-radius: 4px;
    color: #ccc; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    font-family: monospace;
  }
  .glyph-btn:hover { background: #2a2a2a; border-color: #555; }
  .glyph-btn.active { background: #332b00; border-color: #ffd700; color: #ffd700; }

  .controls {
    padding: 12px 16px; border-top: 1px solid #333; display: flex; flex-direction: column; gap: 8px;
  }
  .controls label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }

  .btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    padding: 6px 12px; background: #222; border: 1px solid #444; border-radius: 4px;
    color: #ccc; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .btn:hover { background: #333; border-color: #666; }
  .btn.danger { border-color: #633; color: #f88; }
  .btn.danger:hover { background: #311; }
  .btn.primary { border-color: #663; color: #fd0; }
  .btn.primary:hover { background: #332b00; }

  .mode-indicator {
    padding: 8px 16px; font-size: 12px; color: #888; border-top: 1px solid #333;
  }
  .mode-indicator span { color: #ffd700; }

  .output-section {
    flex: 1; overflow: hidden; display: flex; flex-direction: column;
    border-top: 1px solid #333;
  }
  .output-section label { padding: 8px 16px 4px; }
  .output-section textarea {
    flex: 1; background: #0d0d0d; color: #8f8; border: none; padding: 8px 16px;
    font-family: Consolas, monospace; font-size: 12px; resize: none; outline: none;
  }

  .canvas-area { flex: 1; position: relative; }
  canvas { display: block; width: 100%; height: 100%; }

  .hint {
    position: absolute; bottom: 12px; left: 12px; font-size: 11px; color: #555;
    pointer-events: none;
  }

  .toast {
    position: absolute; top: 12px; right: 12px; background: rgba(50,40,0,0.9);
    border: 1px solid #ffd700; color: #ffd700; padding: 8px 16px; border-radius: 4px;
    font-size: 12px; opacity: 0; transition: opacity 0.3s; pointer-events: none;
  }
  .toast.visible { opacity: 1; }
</style>
</head>
<body>

<div class="sidebar">
  <h2>Glyph Editor</h2>
  <div class="glyph-grid" id="glyph-grid"></div>

  <div class="controls">
    <label>Mode</label>
    <div class="btn-row">
      <button class="btn primary" id="btn-select" onclick="setMode('select')">Select</button>
      <button class="btn" id="btn-add" onclick="setMode('add')">+ Add Node</button>
      <button class="btn" id="btn-move" onclick="setMode('move')">Move</button>
    </div>
    <label>Actions</label>
    <div class="btn-row">
      <button class="btn danger" id="btn-delete" onclick="deleteSelected()">Delete Selected</button>
      <button class="btn" onclick="undoAction()">Undo</button>
      <button class="btn" onclick="redoAction()">Redo</button>
      <button class="btn" onclick="resetGlyph()">Reset</button>
    </div>
    <div class="btn-row">
      <button class="btn primary" onclick="copyOutput()">Copy Data</button>
      <button class="btn primary" onclick="copyFullLine()">Copy Full Line</button>
    </div>
  </div>

  <div class="mode-indicator" id="mode-text">Mode: <span>Select</span> — click a node to select it</div>

  <div class="output-section">
    <label>data array</label>
    <textarea id="output" readonly></textarea>
  </div>
</div>

<div class="canvas-area">
  <canvas id="canvas"></canvas>
  <div class="hint">Scroll to zoom · Right-drag to pan · Keyboard: S=select A=add M=move Del=delete Z=undo</div>
  <div class="toast" id="toast"></div>
</div>

<script>
// -- Glyph data (read from glyphs.ts at build time) --
const GLYPHS = ${glyphsObjSource};

// -- State --
let currentChar = 'a';
let strokes = []; // array of arrays of {x, y}
let selectedNode = null; // {strokeIdx, pointIdx}
let mode = 'select'; // 'select' | 'add' | 'move'
let undoStack = [];
let redoStack = [];
let dragging = null; // for move mode

// View transform
let viewX = 0, viewY = 0, viewScale = 1;
let isPanning = false, panStart = null;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// -- Parse glyph data into strokes --
function parseStrokes(data) {
  const strokes = [];
  let current = [];
  for (let i = 0; i < data.length; i += 2) {
    const x = data[i], y = data[i + 1];
    if (x === -1 && y === -1) {
      if (current.length > 0) { strokes.push(current); current = []; }
    } else {
      current.push({ x, y });
    }
  }
  if (current.length > 0) strokes.push(current);
  return strokes;
}

// -- Serialize strokes back to data array --
function strokesToData(strokes) {
  const data = [];
  for (let i = 0; i < strokes.length; i++) {
    if (i > 0) data.push(-1, -1);
    for (const p of strokes[i]) {
      data.push(Math.round(p.x), Math.round(p.y));
    }
  }
  return data;
}

function saveState() {
  undoStack.push(JSON.stringify(strokes));
  redoStack = [];
  if (undoStack.length > 50) undoStack.shift();
}

function undoAction() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(strokes));
  strokes = JSON.parse(undoStack.pop());
  selectedNode = null;
  updateOutput();
  draw();
}

function redoAction() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(strokes));
  strokes = JSON.parse(redoStack.pop());
  selectedNode = null;
  updateOutput();
  draw();
}

function loadGlyph(ch) {
  currentChar = ch;
  const glyph = GLYPHS[ch];
  if (!glyph) return;
  strokes = parseStrokes([...glyph.data]);
  selectedNode = null;
  undoStack = [];
  redoStack = [];

  // Reset view to fit
  resetView();
  updateOutput();
  draw();
  updateGridHighlight();
}

function resetGlyph() {
  loadGlyph(currentChar);
}

function resetView() {
  // Find bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const stroke of strokes) {
    for (const p of stroke) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) { minX = 0; maxX = 20; minY = -7; maxY = 25; }

  const pad = 4;
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const w = canvas.width;
  const h = canvas.height;
  viewScale = Math.min(w / rangeX, h / rangeY);
  viewX = w / 2 - (minX + rangeX / 2) * viewScale;
  viewY = h / 2 - (minY + rangeY / 2) * viewScale;
}

// -- Coordinate transforms --
function toScreen(p) {
  return { x: p.x * viewScale + viewX, y: p.y * viewScale + viewY };
}

function toWorld(sx, sy) {
  return { x: (sx - viewX) / viewScale, y: (sy - viewY) / viewScale };
}

// -- Drawing --
function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const gridStep = 1;
  const topLeft = toWorld(0, 0);
  const bottomRight = toWorld(w, h);
  const startX = Math.floor(topLeft.x / gridStep) * gridStep;
  const startY = Math.floor(topLeft.y / gridStep) * gridStep;
  for (let gx = startX; gx <= bottomRight.x; gx += gridStep) {
    const sx = gx * viewScale + viewX;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
  }
  for (let gy = startY; gy <= bottomRight.y; gy += gridStep) {
    const sy = gy * viewScale + viewY;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
  }

  // Baseline and cap line
  ctx.strokeStyle = 'rgba(255,215,0,0.12)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (const yLine of [0, 14, 21]) {
    const sy = yLine * viewScale + viewY;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Label guide lines
  ctx.fillStyle = 'rgba(255,215,0,0.25)';
  ctx.font = '10px monospace';
  const labelLines = { 0: 'baseline', 14: 'x-height', 21: 'cap' };
  for (const [yVal, label] of Object.entries(labelLines)) {
    const sy = Number(yVal) * viewScale + viewY;
    ctx.fillText(label, 4, sy - 3);
  }

  // Stroke colors
  const strokeColors = [
    'rgba(100,180,255,0.8)',
    'rgba(255,150,100,0.8)',
    'rgba(100,255,150,0.8)',
    'rgba(255,100,255,0.8)',
    'rgba(255,255,100,0.8)',
    'rgba(100,255,255,0.8)',
  ];

  // Draw edges
  for (let si = 0; si < strokes.length; si++) {
    const stroke = strokes[si];
    const color = strokeColors[si % strokeColors.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (stroke.length > 1) {
      ctx.beginPath();
      const p0 = toScreen(stroke[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let pi = 1; pi < stroke.length; pi++) {
        const p = toScreen(stroke[pi]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  // Draw nodes
  for (let si = 0; si < strokes.length; si++) {
    const stroke = strokes[si];
    const color = strokeColors[si % strokeColors.length];
    for (let pi = 0; pi < stroke.length; pi++) {
      const sp = toScreen(stroke[pi]);
      const isSelected = selectedNode && selectedNode.strokeIdx === si && selectedNode.pointIdx === pi;
      const r = isSelected ? 8 : 5;

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#ffd700' : color;
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : 'rgba(0,0,0,0.5)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Coordinate label
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px monospace';
      ctx.fillText(Math.round(stroke[pi].x) + ',' + Math.round(stroke[pi].y), sp.x + 8, sp.y - 6);
    }
  }

  // Stroke labels
  ctx.font = '11px monospace';
  for (let si = 0; si < strokes.length; si++) {
    if (strokes[si].length === 0) continue;
    const p = toScreen(strokes[si][0]);
    ctx.fillStyle = strokeColors[si % strokeColors.length];
    ctx.fillText('S' + si, p.x - 16, p.y - 10);
  }
}

// -- Find closest node to screen coords --
function findNode(sx, sy, threshold = 12) {
  let best = null, bestDist = threshold;
  for (let si = 0; si < strokes.length; si++) {
    for (let pi = 0; pi < strokes[si].length; pi++) {
      const sp = toScreen(strokes[si][pi]);
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < bestDist) { bestDist = d; best = { strokeIdx: si, pointIdx: pi }; }
    }
  }
  return best;
}

// -- Find closest edge (for adding nodes) --
function findEdge(sx, sy, threshold = 10) {
  let best = null, bestDist = threshold;
  for (let si = 0; si < strokes.length; si++) {
    const stroke = strokes[si];
    for (let pi = 0; pi < stroke.length - 1; pi++) {
      const a = toScreen(stroke[pi]);
      const b = toScreen(stroke[pi + 1]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1) continue;
      let t = ((sx - a.x) * dx + (sy - a.y) * dy) / len2;
      t = Math.max(0.05, Math.min(0.95, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      const d = Math.hypot(px - sx, py - sy);
      if (d < bestDist) {
        bestDist = d;
        const worldPt = {
          x: stroke[pi].x + t * (stroke[pi + 1].x - stroke[pi].x),
          y: stroke[pi].y + t * (stroke[pi + 1].y - stroke[pi].y),
        };
        best = { strokeIdx: si, pointIdx: pi, t, worldPt };
      }
    }
  }
  return best;
}

function deleteSelected() {
  if (!selectedNode) return;
  const { strokeIdx, pointIdx } = selectedNode;
  const stroke = strokes[strokeIdx];
  if (stroke.length <= 2) {
    // Deleting would leave a degenerate stroke — remove entire stroke
    if (stroke.length === 1 || confirm('This stroke only has ' + stroke.length + ' node(s). Remove entire stroke?')) {
      saveState();
      strokes.splice(strokeIdx, 1);
    }
  } else {
    saveState();
    stroke.splice(pointIdx, 1);
  }
  selectedNode = null;
  updateOutput();
  draw();
}

function setMode(m) {
  mode = m;
  selectedNode = null;
  const labels = { select: 'Select — click a node to select it', add: 'Add Node — click on an edge to insert a node', move: 'Move — drag nodes to reposition them' };
  document.getElementById('mode-text').innerHTML = 'Mode: <span>' + m[0].toUpperCase() + m.slice(1) + '</span> — ' + labels[m].split(' — ')[1];
  document.getElementById('btn-select').className = 'btn' + (m === 'select' ? ' primary' : '');
  document.getElementById('btn-add').className = 'btn' + (m === 'add' ? ' primary' : '');
  document.getElementById('btn-move').className = 'btn' + (m === 'move' ? ' primary' : '');
  canvas.style.cursor = m === 'add' ? 'crosshair' : m === 'move' ? 'grab' : 'default';
  draw();
}

function updateOutput() {
  const data = strokesToData(strokes);
  document.getElementById('output').value = data.join(', ');
}

function copyOutput() {
  const data = strokesToData(strokes);
  navigator.clipboard.writeText(data.join(',')).then(() => showToast('Copied data array'));
}

function copyFullLine() {
  const glyph = GLYPHS[currentChar];
  const data = strokesToData(strokes);
  const apos = String.fromCharCode(39);
  const quot = String.fromCharCode(34);
  const key = currentChar === apos ? (quot + currentChar + quot) : (apos + currentChar + apos);
  const line = '  ' + key + ': { width: ' + glyph.width + ', data: [' + data.join(',') + '] },';
  navigator.clipboard.writeText(line).then(() => showToast('Copied full line for glyphs.ts'));
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 1500);
}

// -- Canvas interaction --
function getCanvasXY(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('mousedown', (e) => {
  const { x, y } = getCanvasXY(e);

  // Right-click = pan
  if (e.button === 2) {
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY, vx: viewX, vy: viewY };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (mode === 'select') {
    selectedNode = findNode(x, y);
    draw();
  } else if (mode === 'add') {
    const edge = findEdge(x, y, 15);
    if (edge) {
      saveState();
      const rounded = { x: Math.round(edge.worldPt.x), y: Math.round(edge.worldPt.y) };
      strokes[edge.strokeIdx].splice(edge.pointIdx + 1, 0, rounded);
      selectedNode = { strokeIdx: edge.strokeIdx, pointIdx: edge.pointIdx + 1 };
      updateOutput();
      draw();
    }
  } else if (mode === 'move') {
    const node = findNode(x, y);
    if (node) {
      saveState();
      dragging = node;
      selectedNode = node;
      canvas.style.cursor = 'grabbing';
      draw();
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (isPanning && panStart) {
    const dx = (e.clientX - panStart.x) * (canvas.width / canvas.getBoundingClientRect().width);
    const dy = (e.clientY - panStart.y) * (canvas.height / canvas.getBoundingClientRect().height);
    viewX = panStart.vx + dx;
    viewY = panStart.vy + dy;
    draw();
    return;
  }

  if (dragging) {
    const { x, y } = getCanvasXY(e);
    const world = toWorld(x, y);
    // Snap to integer grid
    const snapped = { x: Math.round(world.x), y: Math.round(world.y) };
    strokes[dragging.strokeIdx][dragging.pointIdx] = snapped;
    updateOutput();
    draw();
  }
});

canvas.addEventListener('mouseup', () => {
  if (isPanning) {
    isPanning = false;
    panStart = null;
    canvas.style.cursor = mode === 'add' ? 'crosshair' : mode === 'move' ? 'grab' : 'default';
  }
  if (dragging) {
    dragging = null;
    canvas.style.cursor = 'grab';
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { x, y } = getCanvasXY(e);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  viewX = x - (x - viewX) * factor;
  viewY = y - (y - viewY) * factor;
  viewScale *= factor;
  draw();
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA') return;
  if (e.key === 's' || e.key === 'S') setMode('select');
  else if (e.key === 'a' || e.key === 'A') setMode('add');
  else if (e.key === 'm' || e.key === 'M') setMode('move');
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) redoAction();
  else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) undoAction();
  else if (e.key === 'y' && (e.ctrlKey || e.metaKey)) redoAction();
});

// -- Build glyph grid --
function updateGridHighlight() {
  document.querySelectorAll('.glyph-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ch === currentChar);
  });
}

const grid = document.getElementById('glyph-grid');
const glyphKeys = Object.keys(GLYPHS).filter(k => k !== ' ');
// Show lowercase first, then uppercase, then symbols
const lowercase = glyphKeys.filter(k => k >= 'a' && k <= 'z');
const uppercase = glyphKeys.filter(k => k >= 'A' && k <= 'Z');
const other = glyphKeys.filter(k => !(k >= 'a' && k <= 'z') && !(k >= 'A' && k <= 'Z'));
const ordered = [...lowercase, ...uppercase, ...other];

for (const ch of ordered) {
  const btn = document.createElement('button');
  btn.className = 'glyph-btn';
  btn.textContent = ch;
  btn.dataset.ch = ch;
  btn.onclick = () => loadGlyph(ch);
  grid.appendChild(btn);
}

// -- Resize --
function resize() {
  const area = canvas.parentElement;
  canvas.width = area.clientWidth * devicePixelRatio;
  canvas.height = area.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  canvas.style.width = area.clientWidth + 'px';
  canvas.style.height = area.clientHeight + 'px';
  // Adjust scale factor for devicePixelRatio
  resetView();
  draw();
}

window.addEventListener('resize', resize);

// -- Init --
resize();
loadGlyph('a');
</script>
</body>
</html>`;

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const outPath = path.join(outDir, 'glyph-editor.html');
fs.writeFileSync(outPath, html, 'utf-8');
console.log(`Glyph editor written to: ${outPath}`);
console.log('Open in a browser to start editing.');
