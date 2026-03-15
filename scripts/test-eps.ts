import { textToGraph } from '../src/lib/engine/glyphs';
for (const eps of [1.0, 1.5, 2.0, 2.5, 3.0, 3.5]) {
  const g = textToGraph('O', eps);
  console.log(`O eps=${eps}: ${g.nodes.length} nodes, ${g.edges.length} edges`);
}
for (const eps of [1.5, 2.0, 2.5, 3.5]) {
  const g = textToGraph('HELLO', eps);
  const byLetter: Record<number, number> = {};
  for (const n of g.nodes) byLetter[n.letterIndex] = (byLetter[n.letterIndex] || 0) + 1;
  console.log(`HELLO eps=${eps}: total=${g.nodes.length}, per-letter: ${JSON.stringify(byLetter)}`);
}
