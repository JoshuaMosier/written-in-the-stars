# Algorithm Improvement Ideas

Ranked by estimated impact-per-effort. Status tracks what's been tried.

## 1. Hierarchical Coarse Search
**Status:** Implemented — 40×40 coarse grid + top-300 → 5×5 fine neighborhood with scale neighbors
**Effort:** Low
**Impact:** ~2× speedup, quality varies by word (some better, some slightly worse)

Run a coarse 40×40 grid with jitter, keep top-300 regions, then refine each in a 5×5
neighborhood including adjacent scales. 25×25 was too sparse (lost good candidates for
some words). 40×40 balances speed and quality. Fine pass uses ±0.6 cell radius.

## 2. Robust Cost Function (Geman-McClure)
**Status:** Reverted — degraded visual quality vs baseline. Needs empirical A/B comparison before re-attempting
**Effort:** Low
**Impact:** Better match quality — outlier nodes stop dominating

Replace `d + d²` with Geman-McClure: `d² / (d² + σ²)`. Bounded in [0,1), quadratic
near zero, saturates for large d. Outlier nodes (far from any star) contribute ~1.0
instead of pulling the optimizer around. σ should relate to local inter-star spacing.

Also: normalize edge distortion as relative error (actual/expected length ratio vs 1.0)
instead of absolute error, so short and long edges contribute proportionally.

## 3. Early Exit in Cost Evaluation
**Status:** Implemented — added costCeiling to gnomonic cost function using global best
**Effort:** Low
**Impact:** ~50% speedup on NM phase for larger words (ORION 1.7×, CONSTELLATION 1.5×)

Extended existing equirectangular early exit to gnomonic cost function. Uses the global
best result cost as ceiling during NM refinement, allowing hopeless evaluations to bail
out after first few nodes. Zero quality impact since only skips worse-than-best evals.

## 4. Scale-Adaptive Position Step
**Status:** Implemented — stride = max(1, floor(scale / cellSize)) in coarse grid
**Effort:** Trivial
**Impact:** Modest speedup + quality improvement on some words (HELLO cost -27%)

At large scales the glyph covers many grid cells, so adjacent positions are highly
correlated. Stride proportional to scale skips redundant positions. Unexpectedly also
improved quality for some words by changing which candidates enter the top-N list.

## 5. Edge-Based Hough Voting
**Status:** Not started
**Effort:** High
**Impact:** Could replace entire coarse grid — orders of magnitude smarter

Each glyph edge has a known length. For a given scale, that maps to an angular separation.
Any star pair matching that separation fully determines (ra, dec, scale).

Algorithm:
1. Pre-compute star-pair angular separations (binned by distance)
2. Pick 2-3 anchor edges (longest/most distinctive)
3. For each matching star pair, compute implied (ra, dec, scale)
4. Vote in 3D accumulator — peaks = candidates
5. Refine peaks with Nelder-Mead

With ~9000 stars there are ~40M pairs, but binning + anchor edge filtering keeps it
tractable. Could produce 100-500 high-quality candidates directly.

## 6. RANSAC-Style Sampling
**Status:** Implemented — 2 longest edges × 1500 sampled stars, supplements grid search
**Effort:** Medium
**Impact:** Major quality improvement on some words (HELLO -45%, ORION -30%)

For the 2 longest glyph edges, hypothesize each sampled star matches one endpoint,
compute where the other star should be, verify with grid lookup, and derive implied
(tx, ty, scale). Adds ~100-400ms but finds geometrically-informed candidates that the
grid search misses entirely. Works as supplement to grid search, not replacement.

## 7. Star Density Pre-Filter
**Status:** Not started
**Effort:** Low
**Impact:** Eliminate 30-50% of positions at larger scales

The glyph at a given scale implies a required star density (N nodes in ~scale² area).
Pre-compute a density map and skip regions that are obviously too sparse. One pass over
the star grid, cheap to compute.

## 8. Adaptive Multi-Start Perturbations
**Status:** Superseded by CMA-ES (#13) — perturbation sizing concept absorbed
**Effort:** Trivial
**Impact:** Improved quality for larger glyphs (ORION -12%, CONSTELLATION -22%)

Fixed perturbations at ±0.005 were too small for large glyphs and too large for small
ones. Scaling proportionally to glyph size allows NM multi-starts to explore the right
neighborhood radius, improving convergence for larger words. Now superseded by CMA-ES
which adaptively scales its search covariance.

## 9. CMA-ES Optimizer (Replace Nelder-Mead Multi-Start)
**Status:** Implemented — 2× seeded CMA-ES(350 evals each) replaces 5× NM multi-start
**Effort:** Medium (~120 lines)
**Impact:** -21% total cost across all test words, faster execution

CMA-ES (Covariance Matrix Adaptation Evolution Strategy) with separable covariance and
seeded PRNG (deterministic per candidate). Two independent runs per candidate with
different seeds for broader exploration. Population size λ=7, μ=3 parents.

Tested variants:
- **Pure CMA-ES (600 evals):** Best single-seed results but non-deterministic. Median
  -16% total cost, but ORION SKY had high variance (occasionally worse than baseline).
- **CMA-ES + NM polish:** NM polish didn't reliably help; added time.
- **CMA-ES + NM hybrid (split budget):** Budget split weakened both optimizers.
- **2× seeded CMA-ES (350 each):** Best overall — deterministic, -21% total cost,
  all words improved, all times under 2s.

Key insight: CMA-ES's population-based search explores beyond NM's local basins.
The 5-start NM was essentially 5 local searches; CMA-ES samples more broadly while
naturally concentrating on promising regions via covariance adaptation.

Seeded PRNG uses xoshiro128** seeded from a hash of the start parameters, ensuring
deterministic results while still exploring different trajectories per candidate.

## 10. Hungarian Optimal Assignment
**Status:** Implemented — Munkres algorithm replaces greedy+swap in Phase 3
**Effort:** Low (~50 lines)
**Impact:** Optimal 1-to-1 assignment — visual quality improvement (not reflected in NM cost metric)

Hungarian algorithm finds the globally optimal minimum-distance 1-to-1 matching of
glyph nodes to stars. Uses top-5 candidate stars per node to keep the cost matrix
small (≤ 325×325 for CONSTELLATION). O(n³) execution time is negligible.

Replaces the previous greedy closest-first + iterative swap refinement heuristic.
The cost metric from `bench-multi.ts` is unchanged because it reports the Phase 2
(NM/CMA-ES) cost, not the Phase 3 assignment quality. Visual verification needed.

---

## Benchmarks

### NM Multi-Start Baseline (2026-03-15)

| Word          | Nodes | Edges | Time (avg) | Cost   |
|---------------|-------|-------|------------|--------|
| HI            | 8     | 6     | 289ms      | 0.2615 |
| STAR          | 24    | 21    | 674ms      | 1.0614 |
| HELLO         | 26    | 22    | 641ms      | 0.8084 |
| ORION SKY     | 47    | 41    | 1167ms     | 1.4536 |
| CONSTELLATION | 65    | 55    | 1671ms     | 2.1377 |
| **Total**     |       |       |            | **5.72** |

### CMA-ES + Hungarian (current, 2026-03-15)

| Word          | Nodes | Edges | Time (avg) | Cost   | Δ Cost |
|---------------|-------|-------|------------|--------|--------|
| HI            | 8     | 6     | 298ms      | 0.2475 | -5%    |
| STAR          | 24    | 21    | 561ms      | 0.6287 | -41%   |
| HELLO         | 26    | 22    | 662ms      | 0.7600 | -6%    |
| ORION SKY     | 47    | 41    | 1280ms     | 1.2147 | -16%   |
| CONSTELLATION | 65    | 55    | 1607ms     | 1.6432 | -23%   |
| **Total**     |       |       |            | **4.49** | **-21%** |

---

## Not Yet Implemented

### 11. Var-Trimmed / Adaptive Trimmed Cost
**Status:** Tested — node cost cap had zero effect on benchmark words
**Effort:** Low
**Impact:** None observed — winning placements already have all per-node costs below tested thresholds

Tested truncated quadratic cost (cap at 2.0 and 0.5). No change to winning costs because
the best placements don't have extreme outlier nodes — the cost is dominated by edge
distortion and duplicate penalties, not individual node outliers. The outlier-domination
problem that killed Geman-McClure (#2) may have been an artifact of the earlier cost
function balance, not the current one.

Still worth revisiting if future cost function changes reintroduce outlier sensitivity.

### 12. Partial Hausdorff Distance Cost
**Status:** Subsumed by Var-Trimmed testing above
**Effort:** Low
**Impact:** Likely none based on Var-Trimmed results

### 13. DIRECT Optimizer (Replace Coarse Grid)
**Status:** Not started
**Effort:** Medium (~80 lines)
**Impact:** Adaptive grid replacement — focuses evaluations on promising regions

DIRECT (Dividing Rectangles) adaptively subdivides the (tx, ty, scale) search box.
Could replace the 40×40 coarse grid + fine refinement with a single adaptive pass.
Risk: cost function evaluations aren't cheap, and DIRECT may need many of them.

Refs: Jones et al. (1993).

### 14. 1-Point RANSAC Scale Decomposition
**Status:** Not started
**Effort:** Medium
**Impact:** Potentially cleaner candidate generation than current 2-point RANSAC

Decompose the 3-DOF transform: first estimate scale via line-vector ratios, then
each single star votes independently for translation. Our current 2-point RANSAC
already works well, but the decomposition might find additional candidates.

Refs: Li et al. (2021).

### 15. Powell's Method (Alternative Local Optimizer)
**Status:** Superseded by CMA-ES
**Effort:** Medium (~60 lines)
**Impact:** Moot — CMA-ES provides a stronger upgrade over NM than Powell would have.

### — Previously Tested (Not Helpful) —

### K-Vector Star-Pair Index + Hough Voting
**Status:** Tested — k-vector Y-band search was slower than sampled RANSAC with worse quality
**Effort:** High
**Impact:** Theoretical advantage didn't materialize for this problem size

Tested approach: sorted stars by Y, binary search for all S2 candidates whose Y-delta
implies valid scale. Issues: (1) iterating all 9000 stars as S1 was slower than sampling
1500, (2) the per-pair overhead exceeded RANSAC's grid-lookup verification, (3) full-
coverage actually produced worse results — worstBestCost ceiling dynamics favor faster
evaluation of fewer high-quality candidates.

### Quad Hashing / Geometric Verification (Astrometry.net style)
**Status:** Tested — multiple variants, none improved on grid+RANSAC baseline
**Effort:** Very high
**Impact:** Does not help for our 3-DOF problem (translation + scale, no rotation)

**Root cause**: Quad hashing solves a 5-DOF problem. Our problem is 3-DOF — a single
star pair already fully constrains the transform. Extra verification nodes provide
filtering, not new geometric information.

Refs: Lang, Hogg, Mierle, Blanton "Astrometry.net" (2010), TETRA star identification.
