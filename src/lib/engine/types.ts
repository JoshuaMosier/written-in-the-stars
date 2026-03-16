/**
 * Shared types for the star-matching engine.
 */

export interface Star {
  idx: number;  // compact sequential index (0..N-1), used for URL encoding
  id: number;
  hip?: number; // Hipparcos catalog number
  ra: number;   // radians, 0 to 2π
  dec: number;  // radians, -π/2 to π/2
  mag: number;
  ci?: number;  // B-V color index (blue=-0.3, white=0, yellow=0.6, red=2.0)
  name?: string;
}

export interface AnchorPoint {
  x: number;
  y: number;
  letterIndex: number;
  strokeIndex: number;
}

export interface GlyphGraph {
  nodes: AnchorPoint[];
  edges: [number, number][];  // pairs of node indices
}

export interface MatchResult {
  pairs: { star: Star; nodeIndex: number }[];
  cost: number;
  transform: { x: number; y: number; scale: number };
  graph: GlyphGraph;
}
