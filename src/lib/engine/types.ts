/**
 * Shared types for the star-matching engine.
 */

import type { AnchorPoint, GlyphGraph } from './glyphs';
export type { AnchorPoint, GlyphGraph };

export interface Star {
	idx: number; // compact sequential index (0..N-1), used for URL encoding
	id: number;
	hip?: number; // Hipparcos catalog number
	ra: number; // radians, 0 to 2π
	dec: number; // radians, -π/2 to π/2
	mag: number;
	ci?: number; // B-V color index (blue=-0.3, white=0, yellow=0.6, red=2.0)
	name?: string;
	wiki?: { url: string; description: string };
}

export interface MatchCostBreakdown {
	pointDistance: number;
	pointDistanceSq: number;
	edgeShape: number;
	duplicates: number;
	blacklist: number;
	total: number;
}

export interface MatchProfile {
	prepMs: number;
	coarseMs: number;
	ransacMs: number;
	refineMs: number;
	assignMs: number;
	totalMs: number;
	coarseEvalCount: number;
	fineEvalCount: number;
	ransacEvalCount: number;
	gnomonicEvalCount: number;
	gnomonicCacheHits: number;
	gnomonicCacheMisses: number;
	refinedCandidateCount: number;
}

export interface MatchResult {
	pairs: { star: Star; nodeIndex: number }[];
	cost: number; // standardized final-assignment score
	searchCost?: number; // nearest-neighbor proxy score used during optimization
	costBreakdown?: MatchCostBreakdown;
	profile?: MatchProfile;
	transform: { x: number; y: number; scale: number };
	graph: GlyphGraph;
}
