import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { textToGraph } from '../src/lib/engine/glyphs';
import { matchStarsToAnchors } from '../src/lib/engine/matcher';
import type { Star } from '../src/lib/engine/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const starsPath = path.resolve(__dirname, '../static/stars.json');
const stars: Star[] = JSON.parse(fs.readFileSync(starsPath, 'utf-8'));

const DEFAULT_PHRASES = ['I', 'STAR', 'ORION', 'HELLO', 'GALAXY', 'NIGHT SKY', 'WRITTEN IN THE STARS'];

function parseArgs() {
	const args = process.argv.slice(2);
	let iterations = 3;
	const phrases: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--iterations' || arg === '-n') {
			const value = Number(args[i + 1]);
			if (!Number.isFinite(value) || value < 1) {
				throw new Error(`Invalid iteration count: ${args[i + 1]}`);
			}
			iterations = Math.floor(value);
			i++;
			continue;
		}
		phrases.push(arg);
	}

	return {
		iterations,
		phrases: phrases.length > 0 ? phrases : DEFAULT_PHRASES,
	};
}

const { iterations, phrases } = parseArgs();

console.log(`Benchmarking matcher on ${stars.length} stars`);
console.log(`Iterations per phrase: ${iterations}`);
console.log('');

const rows = phrases.map((text) => {
	const graph = textToGraph(text);
	let totalMs = 0;
	let minMs = Infinity;
	let maxMs = 0;
	let lastResult = matchStarsToAnchors(stars, graph);

	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		lastResult = matchStarsToAnchors(stars, graph);
		const elapsed = performance.now() - start;
		totalMs += elapsed;
		minMs = Math.min(minMs, elapsed);
		maxMs = Math.max(maxMs, elapsed);
	}

	return {
		text,
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		avgMs: Number((totalMs / iterations).toFixed(1)),
		minMs: Number(minMs.toFixed(1)),
		maxMs: Number(maxMs.toFixed(1)),
		cost: Number(lastResult.cost.toFixed(4)),
		searchCost: Number((lastResult.searchCost ?? Number.NaN).toFixed(4)),
		point: Number((lastResult.costBreakdown?.pointDistance ?? Number.NaN).toFixed(4)),
		pointSq: Number((lastResult.costBreakdown?.pointDistanceSq ?? Number.NaN).toFixed(4)),
		edge: Number((lastResult.costBreakdown?.edgeShape ?? Number.NaN).toFixed(4)),
		duplicates: Number((lastResult.costBreakdown?.duplicates ?? Number.NaN).toFixed(4)),
		blacklist: Number((lastResult.costBreakdown?.blacklist ?? Number.NaN).toFixed(4)),
	};
});

console.table(rows);
