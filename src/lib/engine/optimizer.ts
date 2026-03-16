/**
 * CMA-ES (Covariance Matrix Adaptation Evolution Strategy) optimizer.
 *
 * Population-based global optimizer for low-dimensional (d ≤ 10) noisy
 * multimodal objectives.  Uses separable (diagonal) covariance for speed.
 * Returns the best parameter vector found within the evaluation budget.
 */

interface CmaesOptions {
  /** Initial step size (search radius) */
  sigma?: number;
  /** Maximum function evaluations */
  maxEvals?: number;
}

// Seeded PRNG (xoshiro128**) for deterministic CMA-ES results.
class SeededRng {
  private s: Uint32Array;

  constructor(seed: number) {
    this.s = new Uint32Array(4);
    let z = (seed | 0) >>> 0;
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      this.s[i] = t >>> 0;
    }
  }

  next(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11) >>> 0;
    return result / 4294967296;
  }

  private spare: number | null = null;
  randn(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u: number, v: number, s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);
    this.spare = v * mul;
    return u * mul;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function seedFromParams(params: number[]): number {
  let h = 0x811c9dc5;
  for (const p of params) {
    const buf = new Float64Array([p]);
    const view = new DataView(buf.buffer);
    h ^= view.getUint32(0, true);
    h = Math.imul(h, 0x01000193);
    h ^= view.getUint32(4, true);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Minimize a scalar cost function using CMA-ES.
 *
 * Population-based global optimizer for low-dimensional (d ≤ 10) noisy
 * multimodal objectives. Uses separable (diagonal) covariance for speed
 * and a seeded PRNG (xoshiro128**) for deterministic results given the
 * same starting point.
 *
 * @param f - Cost function to minimize
 * @param start - Initial parameter vector (determines dimensionality and PRNG seed)
 * @param options - Optional sigma (initial step size) and maxEvals (evaluation budget)
 * @returns Parameter vector with the lowest cost found
 */
export function cmaes(
  f: (params: number[]) => number,
  start: number[],
  options: CmaesOptions = {},
): number[] {
  const d = start.length;
  const { sigma: sigma0 = 0.01, maxEvals = 600 } = options;

  const lambda = 4 + Math.floor(3 * Math.log(d + 1));
  const mu = Math.floor(lambda / 2);

  const rawW: number[] = [];
  let sumW = 0;
  for (let i = 0; i < mu; i++) {
    const w = Math.log(mu + 0.5) - Math.log(i + 1);
    rawW.push(w);
    sumW += w;
  }
  const weights = rawW.map(w => w / sumW);
  const muEff = 1 / weights.reduce((s, w) => s + w * w, 0);

  const cs = (muEff + 2) / (d + muEff + 5);
  const ds = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (d + 1)) - 1) + cs;
  const chiN = Math.sqrt(d) * (1 - 1 / (4 * d) + 1 / (21 * d * d));

  const cc = (4 + muEff / d) / (d + 4 + 2 * muEff / d);
  const c1 = 2 / ((d + 1.3) * (d + 1.3) + muEff);
  const cmu_val = Math.min(
    1 - c1,
    2 * (muEff - 2 + 1 / muEff) / ((d + 2) * (d + 2) + muEff),
  );

  const rng = new SeededRng(seedFromParams(start));
  const mean = [...start];
  let sigma = sigma0;
  const diagC = new Float64Array(d).fill(1);
  const ps = new Float64Array(d);
  const pc = new Float64Array(d);

  let bestPoint = [...start];
  let bestVal = f(start);
  let evals = 1;

  const maxGens = Math.floor((maxEvals - 1) / lambda);

  for (let g = 0; g < maxGens; g++) {
    const pop: { x: number[]; val: number }[] = [];
    for (let k = 0; k < lambda; k++) {
      const x = new Array(d);
      for (let i = 0; i < d; i++) {
        x[i] = mean[i] + sigma * Math.sqrt(diagC[i]) * rng.randn();
      }
      pop.push({ x, val: f(x) });
    }
    evals += lambda;

    pop.sort((a, b) => a.val - b.val);
    if (pop[0].val < bestVal) {
      bestVal = pop[0].val;
      bestPoint = [...pop[0].x];
    }

    const newMean = new Array(d).fill(0);
    for (let i = 0; i < mu; i++) {
      for (let j = 0; j < d; j++) {
        newMean[j] += weights[i] * pop[i].x[j];
      }
    }

    const diff = new Array(d);
    for (let i = 0; i < d; i++) {
      diff[i] = (newMean[i] - mean[i]) / sigma;
    }

    let psNormSq = 0;
    for (let i = 0; i < d; i++) {
      ps[i] = (1 - cs) * ps[i] + Math.sqrt(cs * (2 - cs) * muEff) * diff[i] / Math.sqrt(diagC[i]);
      psNormSq += ps[i] * ps[i];
    }
    const psNorm = Math.sqrt(psNormSq);

    const expDecay = 1 - Math.pow(1 - cs, 2 * (g + 1));
    const hsig = psNorm / Math.sqrt(expDecay) / chiN < 1.4 + 2 / (d + 1) ? 1 : 0;
    const pcFactor = Math.sqrt(cc * (2 - cc) * muEff);
    for (let i = 0; i < d; i++) {
      pc[i] = (1 - cc) * pc[i] + hsig * pcFactor * diff[i];
    }

    for (let i = 0; i < d; i++) {
      let rankMuSum = 0;
      for (let k = 0; k < mu; k++) {
        const zi = (pop[k].x[i] - mean[i]) / (sigma * Math.sqrt(diagC[i]));
        rankMuSum += weights[k] * zi * zi;
      }
      diagC[i] = (1 - c1 - cmu_val) * diagC[i]
        + c1 * (pc[i] * pc[i] + (1 - hsig) * cc * (2 - cc) * diagC[i])
        + cmu_val * rankMuSum * diagC[i];
    }

    sigma *= Math.exp((cs / ds) * (psNorm / chiN - 1));
    for (let i = 0; i < d; i++) mean[i] = newMean[i];

    if (sigma < 1e-14) break;
  }

  return bestPoint;
}
