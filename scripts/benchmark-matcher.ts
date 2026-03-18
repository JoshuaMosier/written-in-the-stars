import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { textToGraph } from '../src/lib/engine/glyphs';
import { matchStarsToAnchors, prepareMatcherCatalog } from '../src/lib/engine/matcher';
import type { Star } from '../src/lib/engine/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const starsPath = path.resolve(__dirname, '../static/stars.json');
const stars: Star[] = JSON.parse(fs.readFileSync(starsPath, 'utf-8'));

type SearchMode = 'default' | 'oracle';
type BenchmarkMode = SearchMode | 'compare';

const DEFAULT_PHRASES = ['I', 'STAR', 'ORION', 'HELLO', 'GALAXY', 'NIGHT SKY', 'WRITTEN IN THE STARS'];
const EXTENDED_PHRASES = [
	...DEFAULT_PHRASES,
	'LOOK UP AT THE NIGHT SKY',
	'DANCING AMONG THE STARS',
	'COUNTING ALL THE CONSTELLATIONS',
	'MEET ME UNDER STARLIGHT',
	'FOLLOW THE NORTHERN LIGHTS',
	'DREAMS WRITTEN IN STARLIGHT',
];

interface ParsedArgs {
	iterations: number;
	mode: BenchmarkMode;
	phrases: string[];
}

interface BenchmarkRow {
	text: string;
	nodes: number;
	edges: number;
	avgMs: number;
	minMs: number;
	maxMs: number;
	cost: number;
	searchCost: number;
	point: number;
	pointSq: number;
	edge: number;
	duplicates: number;
	blacklist: number;
	spacing: number;
	clutter: number;
	prepMs: number;
	coarseMs: number;
	ransacMs: number;
	refineMs: number;
	assignMs: number;
	profiledTotalMs: number;
	coarseEvalCount: number;
	fineEvalCount: number;
	ransacEvalCount: number;
	gnomonicEvalCount: number;
	gnomonicCacheHits: number;
	gnomonicCacheMisses: number;
	refinedCandidateCount: number;
	rerankedCandidateCount: number;
	pairStarIndices: number[];
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let iterations = 3;
	let mode: BenchmarkMode = 'default';
	let useExtended = false;
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
		if (arg === '--oracle') {
			mode = 'oracle';
			continue;
		}
		if (arg === '--compare') {
			mode = 'compare';
			continue;
		}
		if (arg === '--extended') {
			useExtended = true;
			continue;
		}
		phrases.push(arg);
	}

	return {
		iterations,
		mode,
		phrases: phrases.length > 0 ? phrases : useExtended ? EXTENDED_PHRASES : DEFAULT_PHRASES,
	};
}

function runPhrase(text: string, iterations: number, searchMode: SearchMode): BenchmarkRow {
	const graph = textToGraph(text);
	let totalMs = 0;
	let minMs = Infinity;
	let maxMs = 0;
	let lastResult = matchStarsToAnchors(stars, graph, null, undefined, { captureProfile: true, searchMode });
	let prepMs = 0;
	let coarseMs = 0;
	let ransacMs = 0;
	let refineMs = 0;
	let assignMs = 0;
	let profiledTotalMs = 0;
	let coarseEvalCount = 0;
	let fineEvalCount = 0;
	let ransacEvalCount = 0;
	let gnomonicEvalCount = 0;
	let gnomonicCacheHits = 0;
	let gnomonicCacheMisses = 0;
	let refinedCandidateCount = 0;
	let rerankedCandidateCount = 0;

	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		lastResult = matchStarsToAnchors(stars, graph, null, undefined, { captureProfile: true, searchMode });
		const elapsed = performance.now() - start;
		totalMs += elapsed;
		minMs = Math.min(minMs, elapsed);
		maxMs = Math.max(maxMs, elapsed);
		prepMs += lastResult.profile?.prepMs ?? 0;
		coarseMs += lastResult.profile?.coarseMs ?? 0;
		ransacMs += lastResult.profile?.ransacMs ?? 0;
		refineMs += lastResult.profile?.refineMs ?? 0;
		assignMs += lastResult.profile?.assignMs ?? 0;
		profiledTotalMs += lastResult.profile?.totalMs ?? 0;
		coarseEvalCount += lastResult.profile?.coarseEvalCount ?? 0;
		fineEvalCount += lastResult.profile?.fineEvalCount ?? 0;
		ransacEvalCount += lastResult.profile?.ransacEvalCount ?? 0;
		gnomonicEvalCount += lastResult.profile?.gnomonicEvalCount ?? 0;
		gnomonicCacheHits += lastResult.profile?.gnomonicCacheHits ?? 0;
		gnomonicCacheMisses += lastResult.profile?.gnomonicCacheMisses ?? 0;
		refinedCandidateCount += lastResult.profile?.refinedCandidateCount ?? 0;
		rerankedCandidateCount += lastResult.profile?.rerankedCandidateCount ?? 0;
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
		spacing: Number((lastResult.costBreakdown?.spacing ?? Number.NaN).toFixed(4)),
		clutter: Number((lastResult.costBreakdown?.clutter ?? Number.NaN).toFixed(4)),
		prepMs: Number((prepMs / iterations).toFixed(2)),
		coarseMs: Number((coarseMs / iterations).toFixed(1)),
		ransacMs: Number((ransacMs / iterations).toFixed(1)),
		refineMs: Number((refineMs / iterations).toFixed(1)),
		assignMs: Number((assignMs / iterations).toFixed(1)),
		profiledTotalMs: Number((profiledTotalMs / iterations).toFixed(1)),
		coarseEvalCount: Math.round(coarseEvalCount / iterations),
		fineEvalCount: Math.round(fineEvalCount / iterations),
		ransacEvalCount: Math.round(ransacEvalCount / iterations),
		gnomonicEvalCount: Math.round(gnomonicEvalCount / iterations),
		gnomonicCacheHits: Math.round(gnomonicCacheHits / iterations),
		gnomonicCacheMisses: Math.round(gnomonicCacheMisses / iterations),
		refinedCandidateCount: Math.round(refinedCandidateCount / iterations),
		rerankedCandidateCount: Math.round(rerankedCandidateCount / iterations),
		pairStarIndices: lastResult.pairs.map((pair) => pair.star.idx).sort((a, b) => a - b),
	};
}

function overlapRatio(left: number[], right: number[]): number {
	if (left.length === 0 && right.length === 0) return 1;
	const rightSet = new Set(right);
	let intersection = 0;
	for (const idx of left) {
		if (rightSet.has(idx)) intersection++;
	}
	return intersection / Math.max(left.length, right.length, 1);
}

function printSingleMode(rows: BenchmarkRow[], mode: SearchMode): void {
	console.log(`Mode: ${mode}`);
	console.table(
		rows.map(
			({
				text,
				nodes,
				edges,
				avgMs,
				minMs,
				maxMs,
				cost,
				searchCost,
				point,
				pointSq,
				edge,
				duplicates,
				blacklist,
				spacing,
				clutter,
			}) => ({
				text,
				nodes,
				edges,
				avgMs,
				minMs,
				maxMs,
				cost,
				searchCost,
				point,
				pointSq,
				edge,
				duplicates,
				blacklist,
				spacing,
				clutter,
			}),
		),
	);

	console.log('');
	console.table(
		rows.map(
			({
				text,
				prepMs,
				coarseMs,
				ransacMs,
				refineMs,
				assignMs,
				profiledTotalMs,
				coarseEvalCount,
				fineEvalCount,
				ransacEvalCount,
				gnomonicEvalCount,
				gnomonicCacheHits,
				gnomonicCacheMisses,
				refinedCandidateCount,
				rerankedCandidateCount,
			}) => ({
				text,
				prepMs,
				coarseMs,
				ransacMs,
				refineMs,
				assignMs,
				profiledTotalMs,
				coarseEvalCount,
				fineEvalCount,
				ransacEvalCount,
				gnomonicEvalCount,
				gnomonicCacheHits,
				gnomonicCacheMisses,
				refinedCandidateCount,
				rerankedCandidateCount,
			}),
		),
	);
}

const { iterations, mode, phrases } = parseArgs();
prepareMatcherCatalog(stars);

console.log(`Benchmarking matcher on ${stars.length} stars`);
console.log(`Iterations per phrase: ${iterations}`);
console.log(`Phrases: ${phrases.length}`);
console.log('');

if (mode === 'compare') {
	const rows = phrases.map((text) => {
		const defaultRow = runPhrase(text, iterations, 'default');
		const oracleRow = runPhrase(text, iterations, 'oracle');
		return {
			text,
			nodes: defaultRow.nodes,
			edges: defaultRow.edges,
			defaultMs: defaultRow.avgMs,
			oracleMs: oracleRow.avgMs,
			overheadPct: Number((((oracleRow.avgMs - defaultRow.avgMs) / defaultRow.avgMs) * 100).toFixed(1)),
			defaultCost: defaultRow.cost,
			oracleCost: oracleRow.cost,
			costGain: Number((defaultRow.cost - oracleRow.cost).toFixed(4)),
			defaultSearchCost: defaultRow.searchCost,
			oracleSearchCost: oracleRow.searchCost,
			searchGain: Number((defaultRow.searchCost - oracleRow.searchCost).toFixed(4)),
			starOverlap: Number(overlapRatio(defaultRow.pairStarIndices, oracleRow.pairStarIndices).toFixed(2)),
			defaultCoarseMs: defaultRow.coarseMs,
			oracleCoarseMs: oracleRow.coarseMs,
			defaultRefineMs: defaultRow.refineMs,
			oracleRefineMs: oracleRow.refineMs,
			defaultAssignMs: defaultRow.assignMs,
			oracleAssignMs: oracleRow.assignMs,
			defaultRefined: defaultRow.refinedCandidateCount,
			oracleRefined: oracleRow.refinedCandidateCount,
			defaultReranked: defaultRow.rerankedCandidateCount,
			oracleReranked: oracleRow.rerankedCandidateCount,
		};
	});

	console.log('Mode: compare (default vs oracle)');
	console.table(
		rows.map(
			({
				text,
				nodes,
				edges,
				defaultMs,
				oracleMs,
				overheadPct,
				defaultCost,
				oracleCost,
				costGain,
				defaultSearchCost,
				oracleSearchCost,
				searchGain,
				starOverlap,
			}) => ({
				text,
				nodes,
				edges,
				defaultMs,
				oracleMs,
				overheadPct,
				defaultCost,
				oracleCost,
				costGain,
				defaultSearchCost,
				oracleSearchCost,
				searchGain,
				starOverlap,
			}),
		),
	);

	console.log('');
	console.table(
		rows.map(
			({
				text,
				defaultCoarseMs,
				oracleCoarseMs,
				defaultRefineMs,
				oracleRefineMs,
				defaultAssignMs,
				oracleAssignMs,
				defaultRefined,
				oracleRefined,
				defaultReranked,
				oracleReranked,
			}) => ({
				text,
				defaultCoarseMs,
				oracleCoarseMs,
				defaultRefineMs,
				oracleRefineMs,
				defaultAssignMs,
				oracleAssignMs,
				defaultRefined,
				oracleRefined,
				defaultReranked,
				oracleReranked,
			}),
		),
	);
} else {
	const rows = phrases.map((text) => runPhrase(text, iterations, mode));
	printSingleMode(rows, mode);
}
