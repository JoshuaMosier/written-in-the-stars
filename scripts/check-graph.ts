import { textToGraph } from '../src/lib/engine/glyphs';
const g = textToGraph('HELLO');
const byLetter: Record<number, number> = {};
for (const n of g.nodes) { byLetter[n.letterIndex] = (byLetter[n.letterIndex] || 0) + 1; }
console.log('Nodes per letter:', byLetter);
console.log('Total nodes:', g.nodes.length, 'edges:', g.edges.length);

const adj: Record<number, Set<number>> = {};
for (const [a, b] of g.edges) {
  if (!adj[a]) adj[a] = new Set(); if (!adj[b]) adj[b] = new Set();
  adj[a].add(b); adj[b].add(a);
}
for (const li of Object.keys(byLetter)) {
  const letterNodes = g.nodes.map((n, i) => ({ ...n, idx: i })).filter(n => n.letterIndex === +li);
  const visited = new Set<number>();
  const queue = [letterNodes[0].idx];
  visited.add(queue[0]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of (adj[cur] || [])) {
      if (!visited.has(nb) && g.nodes[nb].letterIndex === +li) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  const connected = visited.size === letterNodes.length;
  console.log(`Letter ${li}: ${letterNodes.length} nodes, ${visited.size} reachable -> ${connected ? 'CONNECTED' : 'DISCONNECTED'}`);
}
