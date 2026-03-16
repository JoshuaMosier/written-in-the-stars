/**
 * Web Worker for star matching — runs the heavy computation off the main thread.
 */
import { textToGraph } from './glyphs';
import { matchStarsToAnchors } from './matcher';
import type { Star } from './types';

let stars: Star[] | null = null;

self.onmessage = (e: MessageEvent) => {
	const { type, payload } = e.data;

	if (type === 'init') {
		// Receive and cache the star catalog once
		stars = payload.stars;
		self.postMessage({ type: 'ready' });
	} else if (type === 'match') {
		if (!stars) {
			self.postMessage({ type: 'error', payload: 'Worker not initialized' });
			return;
		}
		const graph = textToGraph(payload.text);
		const blacklist = payload.usedStarIndices
			? new Set<number>(payload.usedStarIndices as number[])
			: null;
		const onProgress = (pct: number) => {
			self.postMessage({ type: 'progress', payload: pct });
		};
		const result = matchStarsToAnchors(stars, graph, blacklist, onProgress);
		self.postMessage({ type: 'result', payload: result });
	}
};
