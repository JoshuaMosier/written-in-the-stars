import { textToGraph } from '../src/lib/engine/glyphs';
import { matchStarsToAnchors } from '../src/lib/engine/matcher';
import * as fs from 'fs';

const stars = JSON.parse(fs.readFileSync('src/lib/data/stars.json', 'utf-8'));

const words = ['HI', 'STAR', 'HELLO', 'ORION SKY', 'CONSTELLATION'];

for (const word of words) {
  const graph = textToGraph(word);
  const times: number[] = [];
  const runs = 3;
  let result: any;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = matchStarsToAnchors(stars, graph);
    const t1 = performance.now();
    times.push(t1 - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / runs;
  const min = Math.min(...times);
  console.log(`"${word}" (${graph.nodes.length} nodes, ${graph.edges.length} edges): avg=${avg.toFixed(0)}ms, min=${min.toFixed(0)}ms, cost=${result.cost.toFixed(4)}`);
}
