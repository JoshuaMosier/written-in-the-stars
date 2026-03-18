# How It Works

`Written in the Stars` treats words and short phrases as a geometric matching problem over a real star catalog.

## Pipeline

1. Convert text into a graph.
   Each character is built from Hershey Simplex vector strokes, then normalized into a shared coordinate space.
2. Run a coarse search over the sky.
   Stars are projected into equirectangular coordinates so the matcher can scan a large number of candidate positions and scales quickly.
3. Reproject promising candidates into gnomonic space.
   This removes the local warping introduced by equirectangular projection and makes nearby geometry behave like a flat plane.
4. Refine with CMA-ES.
   The optimizer searches for the best local transform in tangent-plane space.
5. Resolve unique star assignments.
   A greedy nearest-match pass is followed by swap refinement so each glyph node lands on a distinct star while preserving the letter shape.

## Why Gnomonic Refinement Exists

Equirectangular projection is good for broad search, but it distorts shape away from the equator. That is fine for finding candidate regions and bad for final fitting. The matcher therefore switches to a local tangent plane before optimization and final assignment.

## Performance

The app runs the matching pipeline in a Web Worker so the UI stays responsive. Short phrases generally resolve quickly on desktop-class hardware, but long or dense phrases can still take much longer. The current UI caps input at 30 characters and cancels matches that exceed the timeout budget.

## Determinism

Given the same input text and the same star catalog, the matcher is deterministic. The optimizer uses a seeded PRNG derived from its start parameters, which keeps repeated runs stable and makes debugging easier.

## What the Share URL Contains

Shared links encode the matched constellation result and scene settings, not just the input text. Recipients reopen the same text, star assignment, colors, focused constellation, display toggles, brightness, and globe view state.
