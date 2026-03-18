/**
 * Glyph system for converting text into 2D anchor points using Hershey Simplex Roman font data.
 *
 * The Hershey fonts were developed c. 1967 by Dr. Allen Vincent Hershey at the Naval Weapons
 * Laboratory. Each glyph is defined as polyline strokes on roughly a -10 to +10 grid.
 * Coordinate pairs of (-1, -1) indicate a "pen up" (move without drawing) operation.
 *
 * Data source: Hershey Simplex Font via paulbourke.net/dataformats/hershey/
 */

// ---------------------------------------------------------------------------
// Hershey Simplex Roman font data
// Each entry: { width, data: number[] }
//   - width: horizontal advance of the glyph
//   - data: flat array of (x, y) coordinate pairs; (-1, -1) = pen-up
// ---------------------------------------------------------------------------

interface GlyphDef {
	width: number;
	data: number[];
}

const GLYPHS: Record<string, GlyphDef> = {
	' ': { width: 16, data: [] },
	'!': { width: 10, data: [5, 21, 5, 7, -1, -1, 5, 1, 5, 1] },
	'"': { width: 16, data: [4, 21, 4, 14, -1, -1, 12, 21, 12, 14] },
	'#': { width: 21, data: [11, 25, 4, -7, -1, -1, 17, 25, 10, -7, -1, -1, 4, 12, 18, 12, -1, -1, 3, 6, 17, 6] },
	$: {
		width: 20,
		data: [
			8, 25, 8, -4, -1, -1, 12, 25, 12, -4, -1, -1, 17, 18, 15, 20, 12, 21, 8, 21, 5, 20, 3, 18, 3, 16, 4, 14, 5, 13, 7,
			12, 13, 10, 15, 9, 16, 8, 17, 6, 17, 3, 15, 1, 12, 0, 8, 0, 5, 1, 3, 3,
		],
	},
	'%': {
		width: 24,
		data: [
			21, 21, 3, 0, -1, -1, 9, 19, 9, 16, 6, 14, 3, 16, 3, 19, 6, 21, 9, 19, -1, -1, 17, 7, 14, 5, 14, 2, 17, 0, 20, 2,
			20, 5, 17, 7,
		],
	},
	'&': {
		width: 26,
		data: [
			23, 12, 21, 14, 17, 6, 15, 3, 11, 0, 7, 0, 4, 2, 3, 6, 5, 9, 10, 12, 14, 16, 12, 21, 9, 21, 7, 16, 15, 3, 20, 0,
			23, 2,
		],
	},
	"'": { width: 10, data: [5, 21, 6, 20, 6, 18, 4, 15] },
	'(': { width: 14, data: [11, 25, 7, 20, 4, 13, 4, 5, 7, -2, 11, -7] },
	')': { width: 14, data: [3, 25, 7, 20, 10, 13, 10, 5, 7, -2, 3, -7] },
	'*': { width: 16, data: [8, 21, 8, 9, -1, -1, 3, 18, 13, 12, -1, -1, 13, 18, 3, 12] },
	'+': { width: 26, data: [13, 18, 13, 0, -1, -1, 4, 9, 22, 9] },
	',': { width: 10, data: [6, 1, 5, 2, 6, 1, 6, -1, 4, -4] },
	'-': { width: 26, data: [4, 9, 22, 9] },
	'.': { width: 10, data: [5, 2, 4, 1, 5, 0, 6, 1, 5, 2] },
	'/': { width: 22, data: [20, 25, 2, -7] },
	'0': { width: 20, data: [8, 21, 4, 17, 3, 10, 4, 4, 8, 0, 12, 0, 16, 4, 17, 10, 16, 17, 12, 21, 8, 21] },
	'1': { width: 20, data: [11, 21, 11, 0] },
	'2': { width: 20, data: [4, 16, 5, 19, 8, 21, 12, 21, 15, 19, 16, 15, 3, 0, 17, 0] },
	'3': { width: 20, data: [5, 21, 16, 21, 10, 13, 15, 12, 17, 8, 16, 3, 11, 0, 5, 1, 3, 4] },
	'4': { width: 20, data: [13, 21, 3, 7, 13, 7, 18, 7, -1, -1, 13, 21, 13, 7, 13, 0] },
	'5': { width: 20, data: [15, 21, 5, 21, 4, 12, 8, 14, 14, 13, 17, 8, 16, 3, 11, 0, 5, 1, 3, 4] },
	'6': {
		width: 20,
		data: [16, 18, 15, 20, 10, 21, 5, 17, 4, 7, -1, -1, 4, 7, 7, 0, 14, 0, 16, 7, 14, 11, 8, 11, 4, 7],
	},
	'7': { width: 20, data: [17, 21, 7, 0, -1, -1, 3, 21, 17, 21] },
	'8': {
		width: 20,
		data: [4, 18, 4, 14, 10, 11, 17, 7, 17, 3, 10, 0, 3, 3, 3, 7, 10, 11, 16, 14, 16, 18, 10, 21, 4, 18],
	},
	'9': {
		width: 20,
		data: [16, 14, 12, 8, 6, 8, 3, 14, 6, 21, 12, 21, 16, 14, -1, -1, 16, 14, 16, 9, 13, 1, 9, 0, 5, 1, 4, 3],
	},
	':': { width: 10, data: [5, 14, 4, 13, 5, 12, 6, 13, 5, 14, -1, -1, 5, 2, 4, 1, 5, 0, 6, 1, 5, 2] },
	';': { width: 10, data: [5, 14, 4, 13, 5, 12, 6, 13, 5, 14, -1, -1, 6, 1, 5, 2, 6, 1, 6, -1, 4, -4] },
	'<': { width: 24, data: [20, 18, 4, 9, 20, 0] },
	'=': { width: 26, data: [4, 12, 22, 12, -1, -1, 4, 6, 22, 6] },
	'>': { width: 24, data: [4, 18, 20, 9, 4, 0] },
	'?': {
		width: 18,
		data: [3, 16, 4, 19, 7, 21, 12, 21, 15, 17, 14, 13, 9, 10, 9, 7, -1, -1, 9, 2, 8, 1, 9, 0, 10, 1, 9, 2],
	},
	'@': {
		width: 27,
		data: [
			18, 13, 13, 16, 8, 13, 8, 8, 13, 5, 17, 8, -1, -1, 18, 13, 17, 8, 19, 5, 21, 5, 24, 10, 23, 15, 20, 19, 15, 21, 9,
			20, 5, 17, 3, 12, 4, 6, 7, 2, 12, 0, 18, 1, 21, 3,
		],
	},
	A: { width: 18, data: [9, 21, 1, 0, -1, -1, 9, 21, 17, 0, -1, -1, 4, 7, 14, 7] },
	B: {
		width: 21,
		data: [
			4, 21, 4, 0, -1, -1, 4, 21, 13, 21, 16, 20, 18, 17, 18, 15, 16, 12, 13, 11, -1, -1, 4, 11, 13, 11, 16, 10, 18, 7,
			18, 4, 16, 1, 13, 0, 4, 0,
		],
	},
	C: { width: 21, data: [18, 16, 15, 20, 9, 21, 5, 18, 3, 13, 3, 8, 5, 3, 9, 0, 15, 1, 18, 5] },
	D: { width: 21, data: [4, 21, 4, 0, -1, -1, 4, 21, 11, 21, 16, 18, 18, 13, 18, 8, 16, 3, 11, 0, 4, 0] },
	E: { width: 19, data: [4, 21, 4, 0, -1, -1, 4, 21, 17, 21, -1, -1, 4, 11, 12, 11, -1, -1, 4, 0, 17, 0] },
	F: { width: 18, data: [4, 21, 4, 0, -1, -1, 4, 21, 17, 21, -1, -1, 4, 11, 12, 11] },
	G: {
		width: 21,
		data: [18, 16, 15, 20, 9, 21, 5, 18, 3, 13, 3, 8, 5, 3, 9, 0, 15, 1, 18, 5, 18, 8, -1, -1, 13, 8, 18, 8],
	},
	H: { width: 22, data: [4, 21, 4, 0, -1, -1, 18, 21, 18, 0, -1, -1, 4, 11, 18, 11] },
	I: { width: 8, data: [4, 21, 4, 0] },
	J: { width: 16, data: [12, 21, 12, 3, 10, 0, 4, 0, 2, 3, 2, 7] },
	K: { width: 21, data: [4, 21, 4, 0, -1, -1, 18, 21, 4, 7, -1, -1, 9, 12, 18, 0] },
	L: { width: 17, data: [4, 21, 4, 0, -1, -1, 4, 0, 16, 0] },
	M: { width: 24, data: [4, 21, 4, 0, -1, -1, 4, 21, 12, 0, -1, -1, 20, 21, 12, 0, -1, -1, 20, 21, 20, 0] },
	N: { width: 22, data: [4, 21, 4, 0, -1, -1, 4, 21, 18, 0, -1, -1, 18, 21, 18, 0] },
	O: { width: 22, data: [9, 21, 5, 18, 3, 13, 3, 8, 5, 3, 9, 0, 13, 0, 17, 3, 19, 8, 19, 13, 17, 18, 13, 21, 9, 21] },
	P: { width: 21, data: [4, 21, 4, 0, -1, -1, 4, 21, 14, 21, 18, 18, 18, 13, 14, 10, 4, 10] },
	Q: {
		width: 22,
		data: [
			9, 21, 5, 18, 3, 13, 3, 8, 5, 3, 9, 0, 13, 0, 15, 1, 17, 3, 19, 8, 19, 13, 17, 18, 13, 21, 9, 21, -1, -1, 12, 4,
			15, 1, 18, -2,
		],
	},
	R: {
		width: 21,
		data: [
			4, 21, 4, 0, -1, -1, 4, 21, 13, 21, 16, 20, 18, 18, 18, 14, 16, 12, 13, 11, -1, -1, 13, 11, 4, 11, -1, -1, 13, 11,
			18, 0,
		],
	},
	S: { width: 20, data: [17, 18, 13, 21, 7, 21, 3, 16, 7, 11, 15, 9, 17, 4, 13, 0, 7, 0, 3, 3] },
	T: { width: 16, data: [8, 21, 8, 0, -1, -1, 1, 21, 15, 21] },
	U: { width: 22, data: [4, 21, 4, 5, 7, 0, 15, 0, 18, 5, 18, 21] },
	V: { width: 18, data: [1, 21, 9, 0, -1, -1, 17, 21, 9, 0] },
	W: { width: 24, data: [2, 21, 7, 0, -1, -1, 12, 21, 7, 0, -1, -1, 12, 21, 17, 0, -1, -1, 22, 21, 17, 0] },
	X: { width: 20, data: [3, 21, 10, 10, 17, 0, -1, -1, 17, 21, 10, 10, 3, 0] },
	Y: { width: 18, data: [1, 21, 9, 11, 9, 0, -1, -1, 17, 21, 9, 11] },
	Z: { width: 20, data: [17, 21, 3, 0, -1, -1, 3, 21, 17, 21, -1, -1, 3, 0, 17, 0] },

	// Hershey Simplex Roman lowercase (characters 599-624)
	// Y values flipped to match uppercase convention (Y=0 baseline, Y=21 cap top)
	a: { width: 19, data: [15, 8, 17, 0, -1, -1, 15, 8, 11, 14, 4, 10, 4, 10, 4, 2, 4, 2, 11, 0, 15, 8] },
	b: { width: 19, data: [4, 21, 4, 10, 12, 9, 12, 1, 4, 0, 4, 10] },
	c: { width: 18, data: [15, 14, 7, 14, 3, 7, 7, 0, 15, 0] },
	d: { width: 19, data: [15, 21, 15, 10, 7, 9, 7, 1, 15, 0, 15, 10] },
	e: { width: 18, data: [15, 0, 7, 1, 6, 8, 15, 8, 13, 13, 6, 13, 6, 8] },
	f: { width: 12, data: [10, 20, 6, 19, 6, 0, -1, -1, 3, 14, 10, 14] },
	g: { width: 19, data: [15, 11, 15, -2, 13, -6, 6, -6, -1, -1, 15, 11, 9, 14, 3, 10, 3, 4, 9, 0, 15, 3] },
	h: { width: 19, data: [4, 21, 4, 0, -1, -1, 4, 11, 13, 11, 13, 0] },
	i: { width: 8, data: [3, 21, 4, 20, 5, 21, 4, 22, 3, 21, -1, -1, 4, 14, 4, 0] },
	j: { width: 10, data: [5, 21, 6, 20, 7, 21, 6, 22, 5, 21, -1, -1, 6, 14, 6, -4, 4, -7, -1, -7, -3, -4] },
	k: { width: 17, data: [4, 21, 4, 0, -1, -1, 14, 14, 4, 6, -1, -1, 4, 6, 15, 0] },
	l: { width: 8, data: [4, 21, 4, 0] },
	m: {
		width: 30,
		data: [4, 10, 4, 0, -1, -1, 4, 10, 7, 14, 10, 14, 13, 10, 13, 0, -1, -1, 13, 10, 16, 14, 19, 14, 22, 10, 22, 0],
	},
	n: { width: 19, data: [4, 10, 4, 0, -1, -1, 4, 10, 9, 14, 13, 10, 13, 0] },
	o: { width: 19, data: [9, 14, 3, 11, 3, 3, 9, 0, 15, 3, 15, 11, 9, 14] },
	p: { width: 19, data: [4, 11, 4, -7, -1, -1, 4, 11, 7, 14, 12, 14, 16, 10, 16, 5, 12, 0, 7, 0, 4, 4] },
	q: { width: 19, data: [15, 11, 15, -7, -1, -1, 15, 11, 11, 14, 7, 14, 3, 10, 3, 4, 7, 0, 11, 0, 15, 3] },
	r: { width: 13, data: [4, 10, 4, 0, -1, -1, 4, 10, 7, 14, 11, 13] },
	s: { width: 17, data: [14, 12, 11, 14, 6, 12, 6, 9, 14, 5, 14, 2, 11, 0, 6, 2] },
	t: { width: 12, data: [5, 21, 5, 0, -1, -1, 2, 14, 9, 14] },
	u: { width: 19, data: [4, 14, 4, 5, 6, 0, 13, 0, 15, 5, -1, -1, 15, 14, 15, 5] },
	v: { width: 16, data: [2, 14, 8, 0, -1, -1, 14, 14, 8, 0] },
	w: { width: 22, data: [3, 14, 7, 0, -1, -1, 11, 14, 7, 0, -1, -1, 11, 14, 15, 0, -1, -1, 19, 14, 15, 0] },
	x: { width: 17, data: [3, 21, 10, 10, 17, 0, -1, -1, 17, 21, 10, 10, 3, 0] },
	y: { width: 16, data: [2, 14, 8, 0, -1, -1, 14, 14, 8, 0, 2, -7] },
	z: { width: 17, data: [14, 14, 3, 0, -1, -1, 3, 14, 14, 14, -1, -1, 3, 0, 14, 0] },
};

/** Set of characters that have glyph definitions (case-insensitive: lowercase maps to uppercase). */
export const SUPPORTED_CHARS = new Set(Object.keys(GLYPHS));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse flat coordinate data into separate polyline strokes. */
function parseStrokes(data: number[]): { x: number; y: number }[][] {
	const strokes: { x: number; y: number }[][] = [];
	let current: { x: number; y: number }[] = [];

	for (let i = 0; i < data.length; i += 2) {
		const x = data[i];
		const y = data[i + 1];

		if (x === -1 && y === -1) {
			// pen-up: finish the current stroke
			if (current.length > 0) {
				strokes.push(current);
				current = [];
			}
		} else {
			current.push({ x, y });
		}
	}

	if (current.length > 0) {
		strokes.push(current);
	}

	return strokes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AnchorPoint {
	x: number;
	y: number;
	letterIndex: number;
	strokeIndex: number;
}

export interface GlyphGraph {
	nodes: AnchorPoint[];
	edges: [number, number][];
}

// ---------------------------------------------------------------------------
// Geometry helpers for graph building
// ---------------------------------------------------------------------------

interface Pt {
	x: number;
	y: number;
}

/** Find the intersection point of segments (a1-a2) and (b1-b2), if any. */
function segmentIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
	const dx1 = a2.x - a1.x,
		dy1 = a2.y - a1.y;
	const dx2 = b2.x - b1.x,
		dy2 = b2.y - b1.y;
	const denom = dx1 * dy2 - dy1 * dx2;
	if (Math.abs(denom) < 1e-10) return null; // parallel
	const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
	const u = ((b1.x - a1.x) * dy1 - (b1.y - a1.y) * dx1) / denom;
	if (t < 0.01 || t > 0.99 || u < 0.01 || u > 0.99) return null; // not interior
	return { x: a1.x + t * dx1, y: a1.y + t * dy1 };
}

/**
 * Check if point p lies on segment (a-b) at an interior position.
 * Returns the parameter t (0..1) along the segment, or null if not on it.
 */
function pointOnSegment(p: Pt, a: Pt, b: Pt, tolerance = 0.5): number | null {
	const dx = b.x - a.x,
		dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 < 1e-10) return null;
	const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
	if (t < 0.01 || t > 0.99) return null; // must be interior
	// Check perpendicular distance
	const projX = a.x + t * dx,
		projY = a.y + t * dy;
	const perpDist = Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
	if (perpDist > tolerance) return null;
	return t;
}

/** Distance between two points. */
function ptDist(a: Pt, b: Pt): number {
	const dx = a.x - b.x,
		dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Simplify a polyline using Ramer-Douglas-Peucker algorithm.
 * Returns indices of kept points.
 */
function rdpSimplify(points: Pt[], epsilon: number, protectedIndices?: Set<number>): number[] {
	if (points.length <= 2) return points.map((_, i) => i);

	// Find point farthest from line between first and last (or any protected index)
	let maxDist = 0;
	let maxIdx = 0;
	const first = points[0];
	const last = points[points.length - 1];
	const lineLen = ptDist(first, last);

	for (let i = 1; i < points.length - 1; i++) {
		// Protected points are always kept — treat them as infinitely far
		if (protectedIndices?.has(i)) {
			const d = epsilon + 1;
			if (d > maxDist) {
				maxDist = d;
				maxIdx = i;
			}
			continue;
		}
		let d: number;
		if (lineLen < 1e-10) {
			d = ptDist(points[i], first);
		} else {
			// Perpendicular distance to line
			d =
				Math.abs((last.x - first.x) * (first.y - points[i].y) - (first.x - points[i].x) * (last.y - first.y)) / lineLen;
		}
		if (d > maxDist) {
			maxDist = d;
			maxIdx = i;
		}
	}

	if (maxDist > epsilon) {
		const leftProtected = protectedIndices ? new Set([...protectedIndices].filter((i) => i <= maxIdx)) : undefined;
		const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon, leftProtected);
		const rightProtected = protectedIndices
			? new Set([...protectedIndices].filter((i) => i >= maxIdx).map((i) => i - maxIdx))
			: undefined;
		const right = rdpSimplify(points.slice(maxIdx), epsilon, rightProtected);
		// Offset right indices and merge (avoiding duplicate at maxIdx)
		return [...left, ...right.slice(1).map((i) => i + maxIdx)];
	} else {
		// Even when flattening, keep protected indices
		const kept = [0];
		if (protectedIndices) {
			for (let i = 1; i < points.length - 1; i++) {
				if (protectedIndices.has(i)) kept.push(i);
			}
		}
		kept.push(points.length - 1);
		return kept;
	}
}

/**
 * Convert text into a graph of nodes and edges suitable for star matching.
 *
 * Uses Hershey Simplex Roman font data to convert each character into polyline
 * strokes, then builds a unified graph with:
 * - Intersection detection (where strokes cross within a letter)
 * - T-junction detection (stroke endpoints landing on another stroke's segment)
 * - RDP simplification to reduce point count on curves
 * - Coordinate deduplication to merge shared vertices
 * - Normalization to [0, 1] coordinate space
 *
 * @param text - Input text to convert (unsupported characters are skipped)
 * @param simplifyEpsilon - RDP tolerance; higher = fewer points (default 2.0)
 * @returns Graph with deduplicated nodes and edges ready for star matching
 */
export function textToGraph(text: string, simplifyEpsilon = 2.0): GlyphGraph {
	// Phase 1: collect raw strokes per letter with cursor offsets
	interface Stroke {
		points: Pt[];
	}
	const letterStrokes: { letterIndex: number; strokes: Stroke[] }[] = [];
	let cursorX = 0;
	let letterIndex = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const glyph = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()];
		if (!glyph) continue;
		const rawStrokes = parseStrokes(glyph.data);
		const strokes: Stroke[] = rawStrokes.map((s) => ({ points: s.map((p) => ({ x: p.x + cursorX, y: p.y })) }));

		letterStrokes.push({ letterIndex, strokes });
		cursorX += glyph.width;
		letterIndex++;
	}

	if (letterStrokes.length === 0) {
		return { nodes: [], edges: [] };
	}

	// Phase 2: for each letter, find where strokes connect:
	//   a) Segment-segment intersections (X crossings)
	//   b) Stroke endpoints that lie on another stroke's segment (T junctions like H crossbar)
	for (const letter of letterStrokes) {
		const { strokes } = letter;
		const insertions: Map<number, { segIdx: number; t: number; pt: Pt }[]> = new Map();

		const addInsertion = (si: number, segIdx: number, t: number, pt: Pt) => {
			if (!insertions.has(si)) insertions.set(si, []);
			insertions.get(si)!.push({ segIdx, t, pt });
		};

		for (let si = 0; si < strokes.length; si++) {
			for (let sj = si + 1; sj < strokes.length; sj++) {
				const sA = strokes[si].points;
				const sB = strokes[sj].points;

				// a) Check segment-segment intersections
				for (let ai = 0; ai < sA.length - 1; ai++) {
					for (let bi = 0; bi < sB.length - 1; bi++) {
						const ix = segmentIntersection(sA[ai], sA[ai + 1], sB[bi], sB[bi + 1]);
						if (ix) {
							const tA = ptDist(sA[ai], ix) / ptDist(sA[ai], sA[ai + 1]);
							addInsertion(si, ai, tA, ix);
							const tB = ptDist(sB[bi], ix) / ptDist(sB[bi], sB[bi + 1]);
							addInsertion(sj, bi, tB, ix);
						}
					}
				}

				// b) Check endpoints of stroke sj lying on segments of stroke si
				for (const endpoint of [sB[0], sB[sB.length - 1]]) {
					for (let ai = 0; ai < sA.length - 1; ai++) {
						const t = pointOnSegment(endpoint, sA[ai], sA[ai + 1]);
						if (t !== null) {
							addInsertion(si, ai, t, { x: endpoint.x, y: endpoint.y });
						}
					}
				}

				// c) Check endpoints of stroke si lying on segments of stroke sj
				for (const endpoint of [sA[0], sA[sA.length - 1]]) {
					for (let bi = 0; bi < sB.length - 1; bi++) {
						const t = pointOnSegment(endpoint, sB[bi], sB[bi + 1]);
						if (t !== null) {
							addInsertion(sj, bi, t, { x: endpoint.x, y: endpoint.y });
						}
					}
				}
			}
		}

		// Apply insertions (rebuild each stroke with intersection points spliced in)
		for (const [si, ins] of insertions) {
			ins.sort((a, b) => b.segIdx - a.segIdx || b.t - a.t);
			const pts = strokes[si].points;
			for (const { segIdx, pt } of ins) {
				pts.splice(segIdx + 1, 0, pt);
			}
		}
	}

	// Phase 3: simplify strokes (reduce point count on curves)
	// Protect junction points shared between strokes from being removed by RDP
	for (const letter of letterStrokes) {
		for (let si = 0; si < letter.strokes.length; si++) {
			const stroke = letter.strokes[si];
			if (stroke.points.length > 4) {
				// Find indices in this stroke that match points in other strokes
				const protectedIndices = new Set<number>();
				for (let pi = 1; pi < stroke.points.length - 1; pi++) {
					const p = stroke.points[pi];
					for (let sj = 0; sj < letter.strokes.length; sj++) {
						if (si === sj) continue;
						for (const q of letter.strokes[sj].points) {
							if (Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5) {
								protectedIndices.add(pi);
							}
						}
					}
				}
				const kept = rdpSimplify(
					stroke.points,
					simplifyEpsilon,
					protectedIndices.size > 0 ? protectedIndices : undefined,
				);
				stroke.points = kept.map((i) => stroke.points[i]);
			}
		}
	}

	// Compute bounding box across all points
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (const letter of letterStrokes) {
		for (const stroke of letter.strokes) {
			for (const p of stroke.points) {
				if (p.x < minX) minX = p.x;
				if (p.x > maxX) maxX = p.x;
				if (p.y < minY) minY = p.y;
				if (p.y > maxY) maxY = p.y;
			}
		}
	}
	const rangeX = maxX - minX || 1;
	const rangeY = maxY - minY || 1;
	const range = Math.max(rangeX, rangeY);
	const offsetX = (range - rangeX) / 2;
	const offsetY = (range - rangeY) / 2;

	const norm = (p: Pt) => ({
		x: (p.x - minX + offsetX) / range,
		y: (p.y - minY + offsetY) / range,
	});

	// Phase 4: build graph with deduplication (round coords to snap shared points)
	const nodes: AnchorPoint[] = [];
	const edges: [number, number][] = [];
	const edgeSet = new Set<string>(); // prevent duplicate edges

	for (const letter of letterStrokes) {
		const coordToNode = new Map<string, number>();
		const li = letter.letterIndex;

		const getOrCreateNode = (p: Pt, strokeIdx: number): number => {
			// Round to snap nearby points (intersection points vs original points)
			const rx = Math.round(p.x * 100) / 100;
			const ry = Math.round(p.y * 100) / 100;
			const key = `${rx},${ry}`;
			if (coordToNode.has(key)) {
				return coordToNode.get(key)!;
			}
			const n = norm(p);
			const idx = nodes.length;
			nodes.push({ x: n.x, y: n.y, letterIndex: li, strokeIndex: strokeIdx });
			coordToNode.set(key, idx);
			return idx;
		};

		for (let si = 0; si < letter.strokes.length; si++) {
			const stroke = letter.strokes[si];
			let prevIdx: number | null = null;

			for (const p of stroke.points) {
				const nodeIdx = getOrCreateNode(p, si);
				if (prevIdx !== null && prevIdx !== nodeIdx) {
					const eKey = Math.min(prevIdx, nodeIdx) + ':' + Math.max(prevIdx, nodeIdx);
					if (!edgeSet.has(eKey)) {
						edges.push([prevIdx, nodeIdx]);
						edgeSet.add(eKey);
					}
				}
				prevIdx = nodeIdx;
			}
		}
	}

	return { nodes, edges };
}
