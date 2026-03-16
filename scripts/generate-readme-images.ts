/**
 * Generate constellation SVG images for the README.
 *
 * Usage: npx tsx scripts/generate-readme-images.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { textToGraph } from '../src/lib/engine/glyphs';
import { matchStarsToAnchors } from '../src/lib/engine/matcher';
import type { Star, MatchResult } from '../src/lib/engine/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const starsPath = path.resolve(__dirname, '../src/lib/data/stars.json');
const stars: Star[] = JSON.parse(fs.readFileSync(starsPath, 'utf-8'));

const WORDS = ['HELLO', 'ORION', 'DREAM'];
const WIDTH = 800;
const HEIGHT = 400;
const PAD = 40;

function generateSvg(text: string, result: MatchResult): string {
  const pairs = result.pairs;

  // Compute bounding box of matched stars
  let minRA = Infinity, maxRA = -Infinity;
  let minDec = Infinity, maxDec = -Infinity;
  for (const p of pairs) {
    if (p.star.ra < minRA) minRA = p.star.ra;
    if (p.star.ra > maxRA) maxRA = p.star.ra;
    if (p.star.dec < minDec) minDec = p.star.dec;
    if (p.star.dec > maxDec) maxDec = p.star.dec;
  }

  const padRA = (maxRA - minRA) * 0.4 + 0.03;
  const padDec = (maxDec - minDec) * 0.4 + 0.03;
  const ra0 = minRA - padRA;
  const ra1 = maxRA + padRA;
  const dec0 = minDec - padDec;
  const dec1 = maxDec + padDec;

  // Flip RA axis so text reads left-to-right (RA increases right-to-left on the sky)
  const toX = (ra: number) => PAD + ((ra1 - ra) / (ra1 - ra0)) * (WIDTH - 2 * PAD);
  const toY = (dec: number) => PAD + ((dec1 - dec) / (dec1 - dec0)) * (HEIGHT - 2 * PAD);

  const matchedIds = new Set(pairs.map(p => p.star.id));
  const nodeToStar = new Map<number, Star>();
  for (const p of pairs) nodeToStar.set(p.nodeIndex, p.star);

  // Background stars in the region
  const bgStars = stars.filter(s =>
    s.ra >= ra0 && s.ra <= ra1 && s.dec >= dec0 && s.dec <= dec1 && !matchedIds.has(s.id)
  );

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <radialGradient id="glow-${text}">
      <stop offset="0%" stop-color="#ffd700" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffd700" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#0a0a18" rx="8"/>`;

  // Background stars
  for (const s of bgStars) {
    const x = toX(s.ra);
    const y = toY(s.dec);
    const r = Math.max(0.3, 1.8 - s.mag * 0.25);
    const opacity = Math.min(0.6, Math.max(0.08, 0.6 - s.mag / 10));
    svg += `\n  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#c8d2ff" opacity="${opacity.toFixed(2)}"/>`;
  }

  // Constellation edges
  for (const [nA, nB] of result.graph.edges) {
    const sA = nodeToStar.get(nA);
    const sB = nodeToStar.get(nB);
    if (!sA || !sB) continue;
    svg += `\n  <line x1="${toX(sA.ra).toFixed(1)}" y1="${toY(sA.dec).toFixed(1)}" x2="${toX(sB.ra).toFixed(1)}" y2="${toY(sB.dec).toFixed(1)}" stroke="#ffb432" stroke-opacity="0.6" stroke-width="1.5"/>`;
  }

  // Matched stars (glow + dot)
  for (const p of pairs) {
    const x = toX(p.star.ra);
    const y = toY(p.star.dec);
    svg += `\n  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="url(#glow-${text})"/>`;
    svg += `\n  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#ffd700"/>`;
  }

  svg += `\n</svg>`;
  return svg;
}

// Generate images
const outDir = path.resolve(__dirname, '../docs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const word of WORDS) {
  console.log(`Matching "${word}"...`);
  const graph = textToGraph(word);
  const result = matchStarsToAnchors(stars, graph);
  console.log(`  ${graph.nodes.length} nodes, cost ${result.cost.toFixed(4)}`);

  const svg = generateSvg(word, result);
  const svgPath = path.join(outDir, `${word.toLowerCase()}.svg`);
  fs.writeFileSync(svgPath, svg, 'utf-8');

  // Also generate PNG
  const pngPath = path.join(outDir, `${word.toLowerCase()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(pngPath);
  console.log(`  -> ${svgPath}`);
  console.log(`  -> ${pngPath}`);
}

console.log('\nDone!');
