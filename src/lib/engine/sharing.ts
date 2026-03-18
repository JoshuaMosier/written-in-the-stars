/**
 * Packed URL hash encoding/decoding for shared constellations and scene state.
 *
 * Format: base64url(bit-packed payload)
 *
 * Payload layout:
 * - 8 bits  : format version
 * - 8 bits  : constellation count
 * - 8 bits  : focused constellation index (255 = none)
 * - 2 bits  : constellation display mode (ambient, all, none)
 * - 5 bits  : scene toggle bitfield
 * - 5 bits  : brightness slider step (0.0..2.0 in 0.1 increments)
 * - per constellation:
 *   - 10 bits : text length (characters)
 *   - 7 bits  : character code for each supported character
 *   - 9 bits  : color code (0..359 = hue, 360 = white)
 *   - 14 bits : packed star index for each graph node
 */

import { textToGraph } from './glyphs';
import type { MatchResult, Star } from './types';

/** Number of bits used to encode each star index. */
const BITS_PER_IDX = 14;
const FORMAT_VERSION = 3;
const TEXT_LENGTH_BITS = 10;
const TEXT_CHAR_BITS = 7;
const COLOR_BITS = 9;
const COLOR_WHITE_CODE = 360;
const FOCUSED_INDEX_NONE = 0xff;
const CONSTELLATION_MODE_BITS = 2;
const MIN_BRIGHTNESS = 0.0;
const MAX_BRIGHTNESS = 2.0;
const BRIGHTNESS_STEP = 0.1;
const MAX_BRIGHTNESS_CODE = Math.round((MAX_BRIGHTNESS - MIN_BRIGHTNESS) / BRIGHTNESS_STEP);

function rangeChars(from: string, to: string): string[] {
	const start = from.charCodeAt(0);
	const end = to.charCodeAt(0);
	return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}

const SHARE_TEXT_ALPHABET = [
	' ',
	'!',
	'"',
	'#',
	'$',
	'%',
	'&',
	"'",
	'(',
	')',
	'*',
	'+',
	',',
	'-',
	'.',
	'/',
	...rangeChars('0', '9'),
	':',
	';',
	'<',
	'=',
	'>',
	'?',
	'@',
	...rangeChars('A', 'Z'),
	...rangeChars('a', 'z'),
] as const;

const TEXT_CODE_BY_CHAR = new Map<string, number>(
	SHARE_TEXT_ALPHABET.map((char, index) => [char, index]),
);

enum ShareFlag {
	StarLabels = 1 << 0,
	CoordGrid = 1 << 1,
	MonoColor = 1 << 2,
	ShowSun = 1 << 3,
	GlobeView = 1 << 4,
}

export type ConstellationDisplayMode = 'ambient' | 'all' | 'none';

export interface ShareSettings {
	constellationMode: ConstellationDisplayMode;
	starLabels: boolean;
	coordGrid: boolean;
	brightness: number;
	monoColor: boolean;
	showSun: boolean;
	globeView: boolean;
}

export interface ShareEntry {
	text: string;
	result: MatchResult;
	color: string;
}

export interface ShareState {
	entries: ShareEntry[];
	focusedIndex: number;
	settings: ShareSettings;
}

class BitWriter {
	private readonly bytes: number[] = [];
	private bitPos = 0;

	writeBits(value: number, bitCount: number) {
		if (!Number.isInteger(value) || value < 0 || value >= 2 ** bitCount) {
			throw new Error(`Value ${value} does not fit in ${bitCount} bits`);
		}

		for (let bit = bitCount - 1; bit >= 0; bit--) {
			const byteIdx = Math.floor(this.bitPos / 8);
			const bitIdx = 7 - (this.bitPos % 8);
			if (this.bytes.length === byteIdx) this.bytes.push(0);
			this.bytes[byteIdx] |= ((value >> bit) & 1) << bitIdx;
			this.bitPos++;
		}
	}

	toUint8Array(): Uint8Array {
		return Uint8Array.from(this.bytes);
	}
}

class BitReader {
	private bitPos = 0;

	constructor(private readonly bytes: Uint8Array) {}

	readBits(bitCount: number): number | null {
		if (this.bitPos + bitCount > this.bytes.length * 8) return null;

		let value = 0;
		for (let bit = bitCount - 1; bit >= 0; bit--) {
			const byteIdx = Math.floor(this.bitPos / 8);
			const bitIdx = 7 - (this.bitPos % 8);
			value |= ((this.bytes[byteIdx] >> bitIdx) & 1) << bit;
			this.bitPos++;
		}
		return value;
	}
}

function encodeBase64Url(bytes: Uint8Array): string {
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
	try {
		let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		while (normalized.length % 4) normalized += '=';
		const raw = atob(normalized);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

function encodeText(writer: BitWriter, text: string) {
	const chars = Array.from(text);
	if (chars.length >= 2 ** TEXT_LENGTH_BITS) {
		throw new Error(`Text is too long to encode (${chars.length} characters)`);
	}

	writer.writeBits(chars.length, TEXT_LENGTH_BITS);
	for (const char of chars) {
		const code = TEXT_CODE_BY_CHAR.get(char);
		if (code === undefined) {
			throw new Error(`Unsupported share character: ${char}`);
		}
		writer.writeBits(code, TEXT_CHAR_BITS);
	}
}

function decodeText(reader: BitReader): string | null {
	const length = reader.readBits(TEXT_LENGTH_BITS);
	if (length === null) return null;

	let text = '';
	for (let i = 0; i < length; i++) {
		const code = reader.readBits(TEXT_CHAR_BITS);
		if (code === null || code >= SHARE_TEXT_ALPHABET.length) return null;
		text += SHARE_TEXT_ALPHABET[code];
	}
	return text;
}

function clampBrightness(value: number): number {
	return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, value));
}

function encodeBrightness(value: number): number {
	const clamped = clampBrightness(value);
	return Math.min(
		MAX_BRIGHTNESS_CODE,
		Math.max(0, Math.round((clamped - MIN_BRIGHTNESS) / BRIGHTNESS_STEP)),
	);
}

function decodeBrightness(code: number): number {
	return Number((MIN_BRIGHTNESS + code * BRIGHTNESS_STEP).toFixed(1));
}

function colorToHue(color: string): number | null {
	if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
	const r = parseInt(color.slice(1, 3), 16) / 255;
	const g = parseInt(color.slice(3, 5), 16) / 255;
	const b = parseInt(color.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max - min < 0.01) return null;

	const delta = max - min;
	let hue = 0;
	if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
	else if (max === g) hue = ((b - r) / delta + 2) / 6;
	else hue = ((r - g) / delta + 4) / 6;
	return Math.round((hue * 360 + 360) % 360) % 360;
}

function hueToHex(hue: number): string {
	const s = 1;
	const l = 0.5;
	const a = s * Math.min(l, 1 - l);
	const channel = (n: number) => {
		const k = (n + hue / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function encodeColor(color: string): number {
	if (color.toLowerCase() === '#ffffff') return COLOR_WHITE_CODE;
	const hue = colorToHue(color);
	return hue === null ? COLOR_WHITE_CODE : hue;
}

function decodeColor(code: number): string | null {
	if (code === COLOR_WHITE_CODE) return '#ffffff';
	if (code < 0 || code >= COLOR_WHITE_CODE) return null;
	return hueToHex(code);
}

function encodeFlags(settings: ShareSettings): number {
	let flags = 0;
	if (settings.starLabels) flags |= ShareFlag.StarLabels;
	if (settings.coordGrid) flags |= ShareFlag.CoordGrid;
	if (settings.monoColor) flags |= ShareFlag.MonoColor;
	if (settings.showSun) flags |= ShareFlag.ShowSun;
	if (settings.globeView) flags |= ShareFlag.GlobeView;
	return flags;
}

function encodeConstellationMode(mode: ConstellationDisplayMode): number {
	switch (mode) {
		case 'ambient':
			return 0;
		case 'all':
			return 1;
		case 'none':
			return 2;
	}
	const exhaustive: never = mode;
	return exhaustive;
}

function decodeConstellationMode(code: number): ConstellationDisplayMode | null {
	switch (code) {
		case 0:
			return 'ambient';
		case 1:
			return 'all';
		case 2:
			return 'none';
		default:
			return null;
	}
}

function decodeFlags(
	constellationModeCode: number,
	flags: number,
	brightnessCode: number,
): ShareSettings | null {
	const mode = decodeConstellationMode(constellationModeCode);
	if (mode === null) return null;
	return {
		constellationMode: mode,
		starLabels: (flags & ShareFlag.StarLabels) !== 0,
		coordGrid: (flags & ShareFlag.CoordGrid) !== 0,
		brightness: decodeBrightness(brightnessCode),
		monoColor: (flags & ShareFlag.MonoColor) !== 0,
		showSun: (flags & ShareFlag.ShowSun) !== 0,
		globeView: (flags & ShareFlag.GlobeView) !== 0,
	};
}

function sortedPairsForEncoding(result: MatchResult) {
	const sorted = [...result.pairs].sort((a, b) => a.nodeIndex - b.nodeIndex);
	if (sorted.length !== result.graph.nodes.length) {
		throw new Error('Match result is missing graph nodes');
	}
	for (let i = 0; i < sorted.length; i++) {
		if (sorted[i].nodeIndex !== i) {
			throw new Error('Match result pairs must cover each node index exactly once');
		}
	}
	return sorted;
}

export function encodeShareStateToHash(state: ShareState): string {
	if (state.entries.length >= 2 ** 8) {
		throw new Error(`Too many constellations to encode (${state.entries.length})`);
	}

	const focusedIndex =
		state.focusedIndex < 0 ? FOCUSED_INDEX_NONE : state.focusedIndex;
	if (focusedIndex !== FOCUSED_INDEX_NONE && focusedIndex >= state.entries.length) {
		throw new Error(`Focused index ${focusedIndex} is out of bounds`);
	}

	const writer = new BitWriter();
	writer.writeBits(FORMAT_VERSION, 8);
	writer.writeBits(state.entries.length, 8);
	writer.writeBits(focusedIndex, 8);
	writer.writeBits(encodeConstellationMode(state.settings.constellationMode), CONSTELLATION_MODE_BITS);
	writer.writeBits(encodeFlags(state.settings), 5);
	writer.writeBits(encodeBrightness(state.settings.brightness), 5);

	for (const entry of state.entries) {
		encodeText(writer, entry.text);
		writer.writeBits(encodeColor(entry.color), COLOR_BITS);
		for (const pair of sortedPairsForEncoding(entry.result)) {
			writer.writeBits(pair.star.idx, BITS_PER_IDX);
		}
	}

	return encodeBase64Url(writer.toUint8Array());
}

export function decodeHashToShareState(hash: string, starByIdx: Map<number, Star>): ShareState | null {
	const bytes = decodeBase64Url(hash);
	if (!bytes) return null;

	const reader = new BitReader(bytes);
	const version = reader.readBits(8);
	const entryCount = reader.readBits(8);
	const focusedIndex = reader.readBits(8);
	const constellationMode = reader.readBits(CONSTELLATION_MODE_BITS);
	const flags = reader.readBits(5);
	const brightnessCode = reader.readBits(5);

	if (
		version !== FORMAT_VERSION ||
		entryCount === null ||
		focusedIndex === null ||
		constellationMode === null ||
		flags === null ||
		brightnessCode === null ||
		brightnessCode > MAX_BRIGHTNESS_CODE
	) {
		return null;
	}

	const settings = decodeFlags(constellationMode, flags, brightnessCode);
	if (settings === null) return null;

	const entries: ShareEntry[] = [];
	for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
		const text = decodeText(reader);
		if (text === null) return null;

		const graph = textToGraph(text);
		const colorCode = reader.readBits(COLOR_BITS);
		const color = colorCode === null ? null : decodeColor(colorCode);
		if (color === null) return null;

		const pairs: MatchResult['pairs'] = [];
		for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex++) {
			const idx = reader.readBits(BITS_PER_IDX);
			if (idx === null) return null;
			const star = starByIdx.get(idx);
			if (!star) return null;
			pairs.push({ star, nodeIndex });
		}

		entries.push({
			text,
			color,
			result: {
				pairs,
				cost: 0,
				transform: { x: 0, y: 0, scale: 0 },
				graph,
			},
		});
	}

	if (focusedIndex !== FOCUSED_INDEX_NONE && focusedIndex >= entries.length) {
		return null;
	}

	return {
		entries,
		focusedIndex: focusedIndex === FOCUSED_INDEX_NONE ? -1 : focusedIndex,
		settings,
	};
}
