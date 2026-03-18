/**
 * Web Worker for star matching — runs the heavy computation off the main thread.
 *
 * Protocol:
 *   → { type: 'init', payload: { stars: Star[] } }   — cache star catalog
 *   ← { type: 'ready' }
 *   → { type: 'match', payload: { text, usedStarIndices? } }  — run matching
 *   ← { type: 'progress', payload: number }           — progress [0, 1]
 *   ← { type: 'result', payload: MatchResult }        — final result
 *   ← { type: 'error', payload: string }              — on failure
 */
import { textToGraph } from './glyphs';
import { matchStarsToAnchors } from './matcher';
import type { Star } from './types';

let stars: Star[] | null = null;

self.onmessage = (e: MessageEvent) => {
	const { type, payload } = e.data;

	if (type === 'init') {
		stars = payload.stars;
		self.postMessage({ type: 'ready' });
	} else if (type === 'match') {
		const requestId = e.data.requestId;
		if (!stars) {
			self.postMessage({ type: 'error', payload: 'Worker not initialized', requestId });
			return;
		}
		try {
			const graph = textToGraph(payload.text);
			const blacklist = payload.usedStarIndices ? new Set<number>(payload.usedStarIndices as number[]) : null;
			const onProgress = (pct: number) => {
				self.postMessage({ type: 'progress', payload: pct, requestId });
			};
			const result = matchStarsToAnchors(stars, graph, blacklist, onProgress);
			self.postMessage({ type: 'result', payload: result, requestId });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			self.postMessage({ type: 'error', payload: message, requestId });
		}
	}
};
