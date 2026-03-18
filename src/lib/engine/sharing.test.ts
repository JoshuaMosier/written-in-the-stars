import { describe, expect, it } from 'vitest';

import { textToGraph } from './glyphs';
import { decodeHashToShareState, encodeShareStateToHash, type ShareState } from './sharing';
import type { MatchResult, Star } from './types';

function fakeStar(idx: number): Star {
	return { idx, id: idx, ra: idx * 0.1, dec: idx * 0.05, mag: 3.0 };
}

function fakeResult(text: string, starIndices: number[]): MatchResult {
	const graph = textToGraph(text);
	const pairs = starIndices.map((idx, i) => ({ star: fakeStar(idx), nodeIndex: i }));
	return { pairs, cost: 0, transform: { x: 0, y: 0, scale: 1 }, graph };
}

function buildMap(stars: Star[]): Map<number, Star> {
	return new Map(stars.map((star) => [star.idx, star]));
}

function makeState(entries: Array<{ text: string; color: string; baseIdx: number }>): ShareState {
	return {
		entries: entries.map(({ text, color, baseIdx }) => {
			const count = textToGraph(text).nodes.length;
			const indices = Array.from({ length: count }, (_, i) => baseIdx + i);
			return {
				text,
				color,
				result: fakeResult(text, indices),
			};
		}),
		focusedIndex: entries.length - 1,
		settings: {
			constellationMode: 'all',
			starLabels: false,
			coordGrid: true,
			brightness: 1.4,
			monoColor: true,
			showSun: true,
			globeView: true,
		},
	};
}

describe('encodeShareStateToHash / decodeHashToShareState', () => {
	it('round-trips multiple constellations with colors and scene settings', () => {
		const state = makeState([
			{ text: 'Hello, Stars!', color: '#ffffff', baseIdx: 100 },
			{ text: "Orion's Belt", color: '#00ffff', baseIdx: 500 },
		]);
		const allStars = state.entries.flatMap((entry) => entry.result.pairs.map((pair) => pair.star));

		const hash = encodeShareStateToHash(state);
		const decoded = decodeHashToShareState(hash, buildMap(allStars));

		expect(decoded).not.toBeNull();
		expect(decoded!.focusedIndex).toBe(state.focusedIndex);
		expect(decoded!.settings).toEqual(state.settings);
		expect(decoded!.entries.map((entry) => entry.text)).toEqual(state.entries.map((entry) => entry.text));
		expect(decoded!.entries.map((entry) => entry.color)).toEqual(['#ffffff', '#00ffff']);
		expect(decoded!.entries[1].result.pairs.map((pair) => pair.nodeIndex)).toEqual(
			state.entries[1].result.pairs.map((pair) => pair.nodeIndex),
		);
		expect(decoded!.entries[1].result.pairs.map((pair) => pair.star.idx)).toEqual(
			state.entries[1].result.pairs.map((pair) => pair.star.idx),
		);
	});

	it('round-trips lowercase and punctuation text through the packed alphabet', () => {
		const state = makeState([{ text: "don't panic?", color: '#ff0000', baseIdx: 900 }]);
		state.settings.constellationMode = 'none';
		state.settings.brightness = 0;
		const allStars = state.entries[0].result.pairs.map((pair) => pair.star);

		const hash = encodeShareStateToHash(state);
		const decoded = decodeHashToShareState(hash, buildMap(allStars));

		expect(decoded).not.toBeNull();
		expect(decoded!.entries[0].text).toBe("don't panic?");
		expect(decoded!.entries[0].color).toBe('#ff0000');
		expect(decoded!.settings.constellationMode).toBe('none');
		expect(decoded!.settings.brightness).toBe(0);
	});

	it('returns null for invalid or corrupted hashes', () => {
		const map = new Map<number, Star>();

		expect(decodeHashToShareState('', map)).toBeNull();
		expect(decodeHashToShareState('!!!not-base64!!!', map)).toBeNull();
	});

	it('returns null when a shared star index cannot be resolved', () => {
		const state = makeState([{ text: 'A', color: '#ffffff', baseIdx: 2048 }]);
		const hash = encodeShareStateToHash(state);

		expect(decodeHashToShareState(hash, new Map())).toBeNull();
	});

	it('rejects malformed focus metadata', () => {
		const state = makeState([{ text: 'AB', color: '#ffffff', baseIdx: 50 }]);
		state.focusedIndex = 7;

		expect(() => encodeShareStateToHash(state)).toThrow(/Focused index/);
	});
});
