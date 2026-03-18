import sharp from 'sharp';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(__dirname, '../static/og-image.svg');
const outPath = resolve(__dirname, '../static/og-image.png');

const svg = readFileSync(svgPath);

await sharp(svg).resize(1200, 630).png().toFile(outPath);

console.log('Generated og-image.png');
