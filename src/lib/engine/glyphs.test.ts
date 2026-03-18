import { describe, it, expect } from 'vitest';
import { textToGraph } from './glyphs';

describe('textToGraph', () => {
	it('returns nodes and edges for a single letter', () => {
		const graph = textToGraph('A');
		expect(graph.nodes.length).toBeGreaterThan(0);
		expect(graph.edges.length).toBeGreaterThan(0);
	});

	it('returns more nodes for longer text', () => {
		const a = textToGraph('A');
		const ab = textToGraph('AB');
		expect(ab.nodes.length).toBeGreaterThan(a.nodes.length);
	});

	it('assigns correct letterIndex to nodes', () => {
		const graph = textToGraph('AB');
		const letterIndices = new Set(graph.nodes.map((n) => n.letterIndex));
		expect(letterIndices.has(0)).toBe(true);
		expect(letterIndices.has(1)).toBe(true);
	});

	it('produces edges that reference valid node indices', () => {
		const graph = textToGraph('HELLO');
		for (const [a, b] of graph.edges) {
			expect(a).toBeGreaterThanOrEqual(0);
			expect(a).toBeLessThan(graph.nodes.length);
			expect(b).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThan(graph.nodes.length);
		}
	});

	it('handles spaces without crashing', () => {
		const graph = textToGraph('A B');
		expect(graph.nodes.length).toBeGreaterThan(0);
	});

	it('handles unknown characters gracefully', () => {
		// Should not throw, unknown chars are skipped
		const graph = textToGraph('A😊B');
		expect(graph.nodes.length).toBeGreaterThan(0);
	});

	it('supports both uppercase and lowercase letters', () => {
		// The font has distinct glyphs for upper/lowercase
		const upper = textToGraph('ABC');
		const lower = textToGraph('abc');
		expect(upper.nodes.length).toBeGreaterThan(0);
		expect(lower.nodes.length).toBeGreaterThan(0);
	});

	it('produces deterministic output', () => {
		const a = textToGraph('STAR');
		const b = textToGraph('STAR');
		expect(a.nodes).toEqual(b.nodes);
		expect(a.edges).toEqual(b.edges);
	});
});
