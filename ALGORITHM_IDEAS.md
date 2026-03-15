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
**Status:** Implemented — perturbSize = max(0.003, gnoScaleInit × 0.15)
**Effort:** Trivial
**Impact:** Improved quality for larger glyphs (ORION -12%, CONSTELLATION -22%)

Fixed perturbations at ±0.005 were too small for large glyphs and too large for small
ones. Scaling proportionally to glyph size allows NM multi-starts to explore the right
neighborhood radius, improving convergence for larger words.

## 9. Powell's Method (Alternative Local Optimizer)
**Status:** Not started
**Effort:** Medium (~60 lines)
**Impact:** Small — potentially faster convergence than Nelder-Mead for 3D

Uses line searches along coordinate directions. Often outperforms NM in low dimensions.
Not a priority since local optimizer choice matters less than global search strategy.

---

## Research-Backed Ideas (from star tracker / point pattern matching literature)

### 10. K-Vector Star-Pair Index + Hough Voting
**Status:** Tested — k-vector Y-band search was slower than sampled RANSAC with worse quality
**Effort:** High
**Impact:** Theoretical advantage didn't materialize for this problem size

The Pyramid algorithm (Mortari) and astrometry.net use indexed star-pair angular distances
for O(1) range queries. This is the structured version of our RANSAC (#6).

Tested approach: sorted stars by Y, binary search for all S2 candidates whose Y-delta
implies valid scale. Issues: (1) iterating all 9000 stars as S1 was slower than sampling
1500, (2) the per-pair overhead (binary search + band scan + X verification) exceeded
the simple grid-lookup verification in RANSAC, (3) full-coverage (all 9000 stars) actually
produced worse results than 1500-sample — likely because worstBestCost ceiling dynamics
favor faster evaluation of fewer high-quality candidates.

The k-vector approach is designed for problems with unknown rotation (star trackers),
where you MUST index by angular distance. Since we have no rotation, the directional
RANSAC approach (checking a specific expected position) is more efficient.

Refs: Mortari "Pyramid Star Identification Technique", Lang et al. "Astrometry.net" (2010),
ESA tetra3 implementation.

### 11. Hungarian Optimal Assignment
**Status:** Not started
**Effort:** Low (~40 lines)
**Impact:** Better match quality in cost evaluation — prevents node-stealing

Current cost function uses greedy nearest-star assignment with a duplicate penalty.
Hungarian algorithm finds the globally optimal 1-to-1 assignment minimizing total cost.
With n=10-65 nodes, O(n³) is <1ms. Could replace the duplicate penalty entirely.

Use in cost function during NM refinement (too expensive for coarse grid).

Refs: Kuhn "Hungarian Algorithm" (1955), standard assignment problem.

### 12. Partial Hausdorff Distance Cost
**Status:** Not started
**Effort:** Low
**Impact:** More robust matching in sparse sky regions

Instead of penalizing every node equally, use the k-th percentile of node-to-star
distances. Allows some nodes to "miss" gracefully when the local sky is sparse.
Prevents a single bad node from dominating the cost and pulling the optimizer away
from an otherwise excellent placement.

Refs: Huttenlocher et al. "Comparing images using the Hausdorff distance" (1993).

### 13. Quad Hashing (Astrometry.net style)
**Status:** Not started
**Effort:** Very high
**Impact:** O(1) candidate generation — the gold standard for blind plate solving

Select 4-star groups from catalog, hash their geometry into a scale/rotation-invariant
code. At query time, hash glyph sub-quads and look up matching catalog quads instantly.
Since we don't need rotation invariance, the hash is simpler (lower-dimensional).

This is the nuclear option — proven to solve millions of images, but requires significant
offline index construction. Only worth it if k-vector Hough voting (#10) proves insufficient.

Refs: Lang, Hogg, Mierle, Blanton "Astrometry.net" (2010), TETRA star identification.
