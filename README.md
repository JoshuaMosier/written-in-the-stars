# Written in the Stars

Type any text and find real stars in the night sky whose positions spell out your message. With enough stars and enough degrees of freedom, anything can be "written in the stars."

## How it works

1. Text is converted to polyline anchor points using Hershey simplex font data
2. All ~9,100 stars from the Yale Bright Star Catalog are projected into 2D via equirectangular projection
3. A grid search + Nelder-Mead optimizer finds the placement (position, scale) that best maps anchor points to real star positions
4. The result is rendered on an interactive Three.js celestial sphere

## Setup

```
npm install
npm run dev
```

## Scripts

- `npm run dev` — Start dev server
- `npm run build` — Build for production
- `npm run preview` — Preview production build
- `npm run fetch-stars` — Re-fetch star catalog data
- `npm run visualize "TEXT"` — Generate a debug visualization

## Tech

- SvelteKit 2 + Svelte 5 (runes)
- Three.js for 3D celestial sphere rendering
- KD-tree for spatial star lookups
- Nelder-Mead optimization
- Static adapter for deployment
