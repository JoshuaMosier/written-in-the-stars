/**
 * Compact Nelder-Mead (simplex / amoeba) optimizer.
 *
 * Minimizes a scalar cost function f(params) over an unconstrained parameter
 * space. Returns the parameter vector that yields the lowest cost found.
 */

export interface NelderMeadOptions {
  tolerance?: number;
  maxIterations?: number;
  initialScale?: number;
}

export function nelderMead(
  f: (params: number[]) => number,
  start: number[],
  options: NelderMeadOptions = {},
): number[] {
  const { tolerance = 1e-8, maxIterations = 500, initialScale = 0.05 } = options;
  const n = start.length;

  // Build initial simplex: n+1 vertices
  const simplex: { point: number[]; value: number }[] = [];
  const startVal = f(start);
  simplex.push({ point: [...start], value: startVal });

  for (let i = 0; i < n; i++) {
    const p = [...start];
    p[i] += initialScale * (Math.abs(p[i]) + 1);
    simplex.push({ point: p, value: f(p) });
  }

  const alpha = 1.0; // reflection
  const gamma = 2.0; // expansion
  const rho = 0.5;   // contraction
  const sigma = 0.5; // shrink

  for (let iter = 0; iter < maxIterations; iter++) {
    // Sort by value ascending
    simplex.sort((a, b) => a.value - b.value);

    // Convergence check: spread of values
    const lo = simplex[0].value;
    const hi = simplex[n].value;
    if (Math.abs(hi - lo) < tolerance) break;

    // Centroid of all points except the worst
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        centroid[j] += simplex[i].point[j];
      }
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    const worst = simplex[n];
    const secondWorst = simplex[n - 1];

    // Reflection
    const reflected = centroid.map((c, j) => c + alpha * (c - worst.point[j]));
    const reflectedVal = f(reflected);

    if (reflectedVal < secondWorst.value && reflectedVal >= lo) {
      simplex[n] = { point: reflected, value: reflectedVal };
      continue;
    }

    if (reflectedVal < lo) {
      // Expansion
      const expanded = centroid.map((c, j) => c + gamma * (reflected[j] - c));
      const expandedVal = f(expanded);
      simplex[n] = expandedVal < reflectedVal
        ? { point: expanded, value: expandedVal }
        : { point: reflected, value: reflectedVal };
      continue;
    }

    // Contraction
    const contracted = centroid.map((c, j) => c + rho * (worst.point[j] - c));
    const contractedVal = f(contracted);

    if (contractedVal < worst.value) {
      simplex[n] = { point: contracted, value: contractedVal };
      continue;
    }

    // Shrink: move all points toward the best
    const best = simplex[0].point;
    for (let i = 1; i <= n; i++) {
      const p = simplex[i].point.map((v, j) => best[j] + sigma * (v - best[j]));
      simplex[i] = { point: p, value: f(p) };
    }
  }

  simplex.sort((a, b) => a.value - b.value);
  return simplex[0].point;
}
