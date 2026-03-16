import { describe, it, expect } from 'vitest';
import { encodeSingleResult, decodeSingleResult, encodeAllToHash, decodeHashToResults } from './sharing';
import { textToGraph } from './glyphs';
import type { Star, MatchResult } from './types';

/** Create a minimal fake star for testing. */
function fakeStar(idx: number): Star {
	return { idx, id: idx, ra: idx * 0.1, dec: idx * 0.05, mag: 3.0 };
}

/** Build a MatchResult from text and a list of star indices. */
function fakeResult(text: string, starIndices: number[]): MatchResult {
	const graph = textToGraph(text);
	const pairs = starIndices.map((idx, i) => ({ star: fakeStar(idx), nodeIndex: i }));
	return { pairs, cost: 0, transform: { x: 0, y: 0, scale: 1 }, graph };
}

/** Build a starByIdx map from a list of Stars. */
function buildMap(stars: Star[]): Map<number, Star> {
	const map = new Map<number, Star>();
	for (const s of stars) map.set(s.idx, s);
	return map;
}

describe('encodeSingleResult / decodeSingleResult', () => {
	it('round-trips a simple result', () => {
		const text = 'HI';
		const result = fakeResult(text, Array.from({ length: textToGraph(text).nodes.length }, (_, i) => i + 10));
		const allStars = result.pairs.map(p => p.star);
		const encoded = encodeSingleResult(text, result);
		const decoded = decodeSingleResult(encoded, buildMap(allStars));

		expect(decoded).not.toBeNull();
		expect(decoded!.text).toBe(text);
		expect(decoded!.result.pairs.length).toBe(result.pairs.length);
		// Star indices should match
		const originalIndices = result.pairs.map(p => p.star.idx).sort((a, b) => a - b);
		const decodedIndices = decoded!.result.pairs.map(p => p.star.idx).sort((a, b) => a - b);
		expect(decodedIndices).toEqual(originalIndices);
	});

	it('preserves node ordering', () => {
		const text = 'AB';
		const graph = textToGraph(text);
		const indices = Array.from({ length: graph.nodes.length }, (_, i) => 100 + i);
		const result = fakeResult(text, indices);
		const allStars = result.pairs.map(p => p.star);
		const encoded = encodeSingleResult(text, result);
		const decoded = decodeSingleResult(encoded, buildMap(allStars));

		expect(decoded).not.toBeNull();
		for (let i = 0; i < decoded!.result.pairs.length; i++) {
			expect(decoded!.result.pairs[i].nodeIndex).toBe(i);
		}
	});

	it('handles unicode text', () => {
		const text = 'café';
		const graph = textToGraph(text);
		const indices = Array.from({ length: graph.nodes.length }, (_, i) => i + 50);
		const result = fakeResult(text, indices);
		const allStars = result.pairs.map(p => p.star);
		const encoded = encodeSingleResult(text, result);
		const decoded = decodeSingleResult(encoded, buildMap(allStars));

		expect(decoded).not.toBeNull();
		expect(decoded!.text).toBe(text);
	});

	it('returns null for garbage input', () => {
		const map = new Map<number, Star>();
		expect(decodeSingleResult('', map)).toBeNull();
		expect(decodeSingleResult('no-tilde-here', map)).toBeNull();
		expect(decodeSingleResult('~~~', map)).toBeNull();
	});

	it('returns null when star index is not in map', () => {
		const text = 'A';
		const graph = textToGraph(text);
		const indices = Array.from({ length: graph.nodes.length }, (_, i) => 9999 + i);
		const result = fakeResult(text, indices);
		const encoded = encodeSingleResult(text, result);
		// Decode with an empty map — stars won't be found
		expect(decodeSingleResult(encoded, new Map())).toBeNull();
	});
});

describe('encodeAllToHash / decodeHashToResults', () => {
	it('round-trips multiple constellations', () => {
		const entries = ['HI', 'AB'].map(text => {
			const graph = textToGraph(text);
			const indices = Array.from({ length: graph.nodes.length }, (_, i) => i + 200);
			return { text, result: fakeResult(text, indices) };
		});

		const allStars = entries.flatMap(e => e.result.pairs.map(p => p.star));
		const hash = encodeAllToHash(entries);
		expect(hash).toContain('|');

		const decoded = decodeHashToResults(hash, buildMap(allStars));
		expect(decoded.length).toBe(2);
		expect(decoded[0].text).toBe('HI');
		expect(decoded[1].text).toBe('AB');
	});

	it('skips invalid segments gracefully', () => {
		const text = 'A';
		const graph = textToGraph(text);
		const indices = Array.from({ length: graph.nodes.length }, (_, i) => i);
		const result = fakeResult(text, indices);
		const allStars = result.pairs.map(p => p.star);
		const valid = encodeSingleResult(text, result);

		const hash = `garbage|${valid}|also-garbage`;
		const decoded = decodeHashToResults(hash, buildMap(allStars));
		expect(decoded.length).toBe(1);
		expect(decoded[0].text).toBe('A');
	});
});
