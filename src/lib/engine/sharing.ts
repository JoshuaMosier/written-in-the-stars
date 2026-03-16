/**
 * URL hash encoding/decoding for sharing constellations.
 *
 * Compact format: base64url(text) + "~" + base64url(14-bit packed star indices)
 * Multiple constellations are separated by "|" in the URL hash.
 *
 * Each star.idx is packed as 14 bits (max 16383; the catalog has ~8870 stars).
 * Node indices are implicit — array position equals nodeIndex.
 */

import { textToGraph } from './glyphs';
import type { Star, MatchResult } from './types';

/** Number of bits used to encode each star index. */
const BITS_PER_IDX = 14;

/**
 * Encode a single constellation result into a compact URL-safe string.
 *
 * @param text - The original input text
 * @param result - The match result containing star-to-node pairs
 * @returns A string of the form `<base64url(text)>~<base64url(packed star indices)>`
 */
export function encodeSingleResult(text: string, result: MatchResult): string {
	const sorted = [...result.pairs].sort((a, b) => a.nodeIndex - b.nodeIndex);
	const totalBits = sorted.length * BITS_PER_IDX;
	const buf = new Uint8Array(Math.ceil(totalBits / 8));
	let bitPos = 0;
	for (let i = 0; i < sorted.length; i++) {
		const idx = sorted[i].star.idx;
		for (let b = BITS_PER_IDX - 1; b >= 0; b--) {
			const bit = (idx >> b) & 1;
			const byteIdx = Math.floor(bitPos / 8);
			const bitIdx = 7 - (bitPos % 8);
			buf[byteIdx] |= bit << bitIdx;
			bitPos++;
		}
	}
	let b64 = '';
	for (let i = 0; i < buf.length; i++) b64 += String.fromCharCode(buf[i]);
	b64 = btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const textB64 = btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return textB64 + '~' + b64;
}

/**
 * Decode a single constellation segment from a URL hash string.
 *
 * @param segment - A single encoded segment (text~stars)
 * @param starByIdx - Map from star.idx to Star for resolving indices
 * @returns The decoded text and match result, or null if invalid
 */
export function decodeSingleResult(
	segment: string,
	starByIdx: Map<number, Star>,
): { text: string; result: MatchResult } | null {
	try {
		const sepIdx = segment.indexOf('~');
		if (sepIdx < 0) return null;

		let textB64 = segment.slice(0, sepIdx).replace(/-/g, '+').replace(/_/g, '/');
		while (textB64.length % 4) textB64 += '=';
		const text = decodeURIComponent(escape(atob(textB64)));
		const graph = textToGraph(text);

		let b64 = segment.slice(sepIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
		while (b64.length % 4) b64 += '=';
		const raw = atob(b64);
		const buf = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

		const count = graph.nodes.length;
		const totalBits = count * BITS_PER_IDX;
		if (buf.length < Math.ceil(totalBits / 8)) return null;

		const pairs: MatchResult['pairs'] = [];
		let bitPos = 0;
		for (let i = 0; i < count; i++) {
			let idx = 0;
			for (let b = BITS_PER_IDX - 1; b >= 0; b--) {
				const byteIdx = Math.floor(bitPos / 8);
				const bitIdx = 7 - (bitPos % 8);
				idx |= ((buf[byteIdx] >> bitIdx) & 1) << b;
				bitPos++;
			}
			const star = starByIdx.get(idx);
			if (!star) return null;
			pairs.push({ star, nodeIndex: i });
		}
		return {
			text,
			result: { pairs, cost: 0, transform: { x: 0, y: 0, scale: 0 }, graph },
		};
	} catch {
		return null;
	}
}

/**
 * Encode all constellations into a single hash string separated by "|".
 */
export function encodeAllToHash(entries: { text: string; result: MatchResult }[]): string {
	return entries.map(e => encodeSingleResult(e.text, e.result)).join('|');
}

/**
 * Decode a full hash string (possibly multiple "|"-separated constellations).
 */
export function decodeHashToResults(
	hash: string,
	starByIdx: Map<number, Star>,
): { text: string; result: MatchResult }[] {
	const segments = hash.split('|');
	const results: { text: string; result: MatchResult }[] = [];
	for (const seg of segments) {
		const decoded = decodeSingleResult(seg, starByIdx);
		if (decoded) results.push(decoded);
	}
	return results;
}
