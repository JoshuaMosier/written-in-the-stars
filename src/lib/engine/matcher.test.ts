import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { matchStarsToAnchors } from './matcher';
import { textToGraph } from './glyphs';
import type { Star } from './types';

let stars: Star[];

beforeAll(() => {
	const raw = readFileSync(resolve(__dirname, '../../../static/stars.json'), 'utf-8');
	stars = JSON.parse(raw);
});

describe('matchStarsToAnchors', () => {
	describe('basic matching', () => {
		it('returns a valid MatchResult for a simple letter', () => {
			const graph = textToGraph('I');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.pairs.length).toBeGreaterThan(0);
			expect(result.cost).toBeLessThan(Infinity);
			expect(result.graph).toBe(graph);
		});

		it('maps each pair to a node index and a star', () => {
			const graph = textToGraph('L');
			const result = matchStarsToAnchors(stars, graph);

			for (const pair of result.pairs) {
				expect(pair.nodeIndex).toBeGreaterThanOrEqual(0);
				expect(pair.nodeIndex).toBeLessThan(graph.nodes.length);
				expect(pair.star).toBeDefined();
				expect(pair.star.idx).toBeGreaterThanOrEqual(0);
				expect(pair.star.idx).toBeLessThan(stars.length);
			}
		});

		it('produces no duplicate star indices', () => {
			const graph = textToGraph('L');
			const result = matchStarsToAnchors(stars, graph);

			const starIndices = result.pairs.map((p) => p.star.idx);
			const unique = new Set(starIndices);
			expect(unique.size).toBe(starIndices.length);
		});

		it('returns a transform with valid coordinates', () => {
			const graph = textToGraph('I');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.transform.x).toBeGreaterThanOrEqual(0);
			expect(result.transform.x).toBeLessThanOrEqual(1);
			expect(result.transform.y).toBeGreaterThanOrEqual(0);
			expect(result.transform.y).toBeLessThanOrEqual(1);
			expect(result.transform.scale).toBeGreaterThan(0);
		});

		it('reports both proxy and final standardized costs', () => {
			const graph = textToGraph('HI');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.searchCost).toBeLessThan(Infinity);
			expect(result.costBreakdown).toBeDefined();
			expect(result.costBreakdown!.total).toBe(result.cost);
			expect(result.costBreakdown!.duplicates).toBe(0);
		});
	});

	describe('multi-letter text', () => {
		it('returns pairs for all glyph nodes', () => {
			const graph = textToGraph('HI');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.pairs.length).toBe(graph.nodes.length);
		});

		it('has correct letterIndices spanning all letters', () => {
			const graph = textToGraph('AB');
			const result = matchStarsToAnchors(stars, graph);

			const nodeIndicesInResult = new Set(result.pairs.map((p) => p.nodeIndex));
			// Every node should be represented
			for (let i = 0; i < graph.nodes.length; i++) {
				expect(nodeIndicesInResult.has(i)).toBe(true);
			}

			// Nodes from both letters should be present
			const letterIndices = new Set(result.pairs.map((p) => graph.nodes[p.nodeIndex].letterIndex));
			expect(letterIndices.has(0)).toBe(true);
			expect(letterIndices.has(1)).toBe(true);
		});
	});

	describe('determinism', () => {
		it('produces the same output for the same input', () => {
			const graph = textToGraph('T');
			const result1 = matchStarsToAnchors(stars, graph);
			const result2 = matchStarsToAnchors(stars, graph);

			expect(result1.cost).toBe(result2.cost);
			expect(result1.pairs.length).toBe(result2.pairs.length);

			const indices1 = result1.pairs.map((p) => p.star.idx).sort((a, b) => a - b);
			const indices2 = result2.pairs.map((p) => p.star.idx).sort((a, b) => a - b);
			expect(indices1).toEqual(indices2);

			expect(result1.transform).toEqual(result2.transform);
		});
	});

	describe('edge cases', () => {
		it('returns empty pairs for empty text', () => {
			const graph = textToGraph('');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.pairs).toEqual([]);
			expect(result.cost).toBe(Infinity);
		});

		it('returns empty pairs for text with only spaces', () => {
			const graph = textToGraph('   ');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.pairs).toEqual([]);
			expect(result.cost).toBe(Infinity);
		});

		it('handles a single character', () => {
			const graph = textToGraph('V');
			const result = matchStarsToAnchors(stars, graph);

			expect(result.pairs.length).toBeGreaterThan(0);
			expect(result.pairs.length).toBe(graph.nodes.length);
			expect(result.cost).toBeLessThan(Infinity);
		});

		it('returns empty result when star catalog is empty', () => {
			const graph = textToGraph('A');
			const result = matchStarsToAnchors([], graph);

			expect(result.pairs).toEqual([]);
			expect(result.cost).toBe(Infinity);
		});
	});

	describe('blacklist', () => {
		it('avoids blacklisted stars when possible', () => {
			const graph = textToGraph('I');

			// First run without blacklist
			const baseline = matchStarsToAnchors(stars, graph);
			const baselineIndices = new Set(baseline.pairs.map((p) => p.star.idx));

			// Blacklist those stars and run again
			const result = matchStarsToAnchors(stars, graph, baselineIndices);

			const resultIndices = new Set(result.pairs.map((p) => p.star.idx));
			// At least some stars should differ since we blacklisted the baseline ones
			const overlap = [...resultIndices].filter((idx) => baselineIndices.has(idx));
			expect(overlap.length).toBeLessThan(baselineIndices.size);
		});
	});
});
