<script lang="ts">
	import { encodeAllToHash, decodeHashToResults } from '$lib/engine/sharing';
	import type { Star, MatchResult } from '$lib/engine/types';
	import { CONSTELLATIONS } from '$lib/data/constellations';
	import { SUPPORTED_CHARS } from '$lib/engine/glyphs';
	import MatchWorker from '$lib/engine/match.worker?worker';

	// Lazy-load StarField (pulls in Three.js tree)
	const StarFieldPromise = import('$lib/scene/StarField.svelte');

	// Fetch star catalog at runtime instead of bundling it
	// Keep a plain (non-proxy) reference for worker postMessage
	let starsRaw: Star[] = [];
	let stars: Star[] = $state([]);
	let starByIdx = new Map<number, Star>();
	let starsReady = $state(false);

	let starsError = $state('');

	const starsPromise = fetch('/stars.json')
		.then(r => {
			if (!r.ok) throw new Error(`Failed to load star catalog (${r.status})`);
			return r.json();
		})
		.then((data: Star[]) => {
			// Add the Sun if not already present (filtered out of older star catalog builds)
			if (!data.some(s => s.mag < -10)) {
				const sunIdx = data.length;
				data.push({ idx: sunIdx, id: 0, ra: 0, dec: 0, mag: -26.7, ci: 0.66, name: 'Sol' });
			}
			starsRaw = data;
			stars = starsRaw;
			for (const s of starsRaw) starByIdx.set(s.idx, s);
			initAfterStarsLoaded();
			starsReady = true;
		})
		.catch((err) => {
			starsError = err instanceof Error ? err.message : 'Failed to load star catalog';
		});

	interface ConstellationEntry {
		text: string;
		name: string;
		starCount: number;
		catalogId: string;
		result: MatchResult;
		color: string;
	}

	const matchingPhrases = [
		'consulting the fates',
		'reading the heavens',
		'charting the firmament',
		'seeking augury',
		'invoking the muses',
		'divining the cosmos',
		'aligning the stars',
		'interpreting the omens',
		'petitioning the muses',
		'querying the gods',
		'consulting Urania',
		'beseeching the heavens',
		'mapping the celestial sphere',
		'tracing the ecliptic',
		'surveying the heavens',
		'scanning the zodiac',
		'stargazing',
		'connecting the dots',
		'tuning the spheres',
		'waiting for a clear night',
		'asking the oracle',
		'casting the horoscope',
	];
	let matchingPhrase = $state(matchingPhrases[Math.floor(Math.random() * matchingPhrases.length)]);
	let matchingPhraseInterval: ReturnType<typeof setInterval> | null = null;

	function startMatchingPhrases() {
		matchingPhrase = matchingPhrases[Math.floor(Math.random() * matchingPhrases.length)];
		matchingPhraseInterval = setInterval(() => {
			matchingPhrase = matchingPhrases[Math.floor(Math.random() * matchingPhrases.length)];
		}, 4000);
	}

	function stopMatchingPhrases() {
		if (matchingPhraseInterval) {
			clearInterval(matchingPhraseInterval);
			matchingPhraseInterval = null;
		}
	}

	let inputText = $state('');
	let inputRejectMsg = $state('');
	let inputRejectTimer: ReturnType<typeof setTimeout> | null = null;

	function filterInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const raw = input.value;
		let filtered = '';
		const rejected: string[] = [];
		for (const ch of raw) {
			if (SUPPORTED_CHARS.has(ch) || SUPPORTED_CHARS.has(ch.toUpperCase())) {
				filtered += ch;
			} else if (!rejected.includes(ch)) {
				rejected.push(ch);
			}
		}
		if (rejected.length > 0) {
			inputText = filtered;
			// Re-trigger shake animation by removing and re-adding the class
			input.classList.remove('shake');
			void input.offsetWidth; // force reflow
			input.classList.add('shake');
			if (inputRejectTimer) clearTimeout(inputRejectTimer);
			inputRejectMsg = `"${rejected.join('", "')}" not supported`;
			inputRejectTimer = setTimeout(() => { inputRejectMsg = ''; }, 2000);
		}
	}

	let isMatching = $state(false);
	let isRerolling = $state(false);
	let matchProgress = $state(0);
	let showInput = $state(true);
	let starField = $state<any>(null);
	let constellations: ConstellationEntry[] = $state([]);
	let focusedIndex = $state(-1);
	let rerollBlacklist: number[] = [];  // accumulates stars from previous re-rolls

	// --- Hue ring color picker ---
	let colorPickerOpen = $state<number | null>(null);
	let colorDragActive = false;
	let colorUpdateRaf = 0;

	function hslToHex(h: number): string {
		const s = 1, l = 0.5;
		const a = s * Math.min(l, 1 - l);
		const f = (n: number) => {
			const k = (n + h / 30) % 12;
			const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
			return Math.round(255 * color).toString(16).padStart(2, '0');
		};
		return `#${f(0)}${f(8)}${f(4)}`;
	}

	function hexToHue(hex: string): number | null {
		const r = parseInt(hex.slice(1, 3), 16) / 255;
		const g = parseInt(hex.slice(3, 5), 16) / 255;
		const b = parseInt(hex.slice(5, 7), 16) / 255;
		const max = Math.max(r, g, b), min = Math.min(r, g, b);
		if (max - min < 0.01) return null;
		const d = max - min;
		let h = 0;
		if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
		else if (max === g) h = ((b - r) / d + 2) / 6;
		else h = ((r - g) / d + 4) / 6;
		return h * 360;
	}

	function updateConstellationColor(index: number, color: string) {
		constellations[index] = { ...constellations[index], color };
		cancelAnimationFrame(colorUpdateRaf);
		colorUpdateRaf = requestAnimationFrame(() => {
			starField?.redrawConstellations(constellations.map(c => c.result), constellations.map(c => c.color));
		});
	}

	function hueFromPointer(e: PointerEvent, container: HTMLElement): number {
		const rect = container.getBoundingClientRect();
		const dx = e.clientX - (rect.left + rect.width / 2);
		const dy = e.clientY - (rect.top + rect.height / 2);
		return ((Math.atan2(dy, dx) * 180 / Math.PI) + 90 + 360) % 360;
	}

	function handleRingStart(e: PointerEvent, index: number) {
		if ((e.target as HTMLElement).closest('.hue-ring-center')) return;
		const container = e.currentTarget as HTMLElement;
		container.setPointerCapture(e.pointerId);
		colorDragActive = true;
		updateConstellationColor(index, hslToHex(hueFromPointer(e, container)));
	}

	function handleRingMove(e: PointerEvent, index: number) {
		if (!colorDragActive) return;
		const container = e.currentTarget as HTMLElement;
		updateConstellationColor(index, hslToHex(hueFromPointer(e, container)));
	}

	function handleRingEnd() {
		if (colorDragActive) {
			colorDragActive = false;
			colorPickerOpen = null;
		}
	}

	function makeEntry(text: string, result: MatchResult): ConstellationEntry {
		const now = new Date();
		return {
			text,
			name: text,
			starCount: result.pairs.length,
			catalogId: `WSC ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`,
			result,
			color: '#ffffff',
		};
	}

	function showResult(text: string, result: MatchResult) {
		const entry = makeEntry(text, result);
		constellations = [...constellations, entry];
		focusedIndex = constellations.length - 1;

		showInput = false;
		stopMatchingPhrases();
		isMatching = false;

		// Update URL hash with all constellations
		history.replaceState(null, '', '#' + encodeAllToHash(constellations));

		starField?.animateToMatch(result, false, entry.color);
	}

	// --- Check URL hash on load ---
	let pendingHashResults: { text: string; result: MatchResult }[] = [];
	let hashWasPresent = typeof window !== 'undefined' && window.location.hash.length > 1;

	// Initialize web worker and decode hash after stars are fetched
	let worker = newWorker();

	function newWorker(): InstanceType<typeof MatchWorker> {
		const w = new MatchWorker();
		w.onmessage = handleWorkerMessage;
		w.onerror = handleWorkerError;
		return w;
	}

	// Stars suitable for matching (excludes the Sun and other extreme objects)
	const matchableStars = () => starsRaw.filter(s => s.mag > -10);

	function respawnWorker() {
		worker.terminate();
		worker = newWorker();
		if (starsReady) {
			worker.postMessage({ type: 'init', payload: { stars: matchableStars() } });
		}
	}

	function initAfterStarsLoaded() {
		worker.postMessage({ type: 'init', payload: { stars: matchableStars() } });
		if (hashWasPresent) {
			pendingHashResults = decodeHashToResults(window.location.hash.slice(1), starByIdx);
		}
	}

	function handleStarFieldReady() {
		if (pendingHashResults.length > 0) {
			const results = pendingHashResults;
			pendingHashResults = [];
			requestAnimationFrame(() => {
				// Build all constellation entries without triggering individual animations
				for (const { text, result } of results) {
					constellations = [...constellations, makeEntry(text, result)];
				}
				focusedIndex = constellations.length - 1;
				showInput = false;
				// Use refocusConstellation to draw all and animate camera to the last one
				const allResults = constellations.map(c => c.result);
				starField?.refocusConstellation(allResults, focusedIndex, constellations.map(c => c.color));
			});
		} else if (hashWasPresent) {
			// Hash was in the URL but nothing decoded — show error and clean up URL
			history.replaceState(null, '', window.location.pathname);
			errorMessage = 'This shared link appears to be invalid or corrupted.';
			setTimeout(() => (errorMessage = ''), 4000);
		}
	}

	let errorMessage = $state('');
	const MATCH_TIMEOUT_MS = 60_000;
	let matchTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let matchRequestId = 0;

	function clearMatchTimeout() {
		if (matchTimeoutId !== null) {
			clearTimeout(matchTimeoutId);
			matchTimeoutId = null;
		}
	}

	function startMatchTimeout() {
		clearMatchTimeout();
		matchTimeoutId = setTimeout(() => {
			if (!isMatching) return;
			matchRequestId++; // invalidate the in-flight request
			respawnWorker(); // kill the blocked worker so the next request isn't queued behind it
			stopMatchingPhrases();
			if (isRerolling) showInput = false;
			isMatching = false;
			isRerolling = false;
			errorMessage = 'Star matching timed out. Try a shorter word or try again.';
			setTimeout(() => (errorMessage = ''), 4000);
		}, MATCH_TIMEOUT_MS);
	}

	function handleWorkerMessage(e: MessageEvent) {
		const { type, payload, requestId } = e.data;
		if (requestId !== undefined && requestId !== matchRequestId) return;
		if (type === 'progress') {
			matchProgress = payload as number;
		} else if (type === 'result') {
			clearMatchTimeout();
			matchProgress = 1;
			if (isRerolling) {
				handleRerollResult(pendingText, payload as MatchResult);
			} else {
				showResult(pendingText, payload as MatchResult);
			}
		} else if (type === 'error') {
			clearMatchTimeout();
			if (isRerolling) showInput = false;
			isMatching = false;
			isRerolling = false;
			errorMessage = 'Something went wrong matching stars. Please try again.';
			setTimeout(() => (errorMessage = ''), 4000);
		}
	}

	function handleWorkerError() {
		clearMatchTimeout();
		stopMatchingPhrases();
		if (isRerolling) showInput = false;
		isMatching = false;
		isRerolling = false;
		errorMessage = 'Something went wrong. Please try again.';
		setTimeout(() => (errorMessage = ''), 4000);
	}

	function cancelMatch() {
		if (!isMatching) return;
		matchRequestId++;
		clearMatchTimeout();
		respawnWorker();
		stopMatchingPhrases();
		if (isRerolling) showInput = false;
		isMatching = false;
		isRerolling = false;
	}

	let pendingText = '';

	function getUsedStarIndices(): number[] {
		const indices: number[] = [];
		for (const entry of constellations) {
			for (const pair of entry.result.pairs) {
				indices.push(pair.star.idx);
			}
		}
		return indices;
	}

	function handleSubmit() {
		const text = inputText.trim();
		if (!text || !starsReady) return;

		rerollBlacklist = [];
		isMatching = true;
		matchProgress = 0;
		startMatchingPhrases();
		pendingText = text;
		const usedStarIndices = getUsedStarIndices();
		const requestId = ++matchRequestId;
		startMatchTimeout();
		worker.postMessage({ type: 'match', payload: { text, usedStarIndices }, requestId });
	}

	let rerollIndex = -1;  // which constellation is being re-rolled

	function handleRerollResult(text: string, result: MatchResult) {
		const entry = makeEntry(text, result);
		constellations = [
			...constellations.slice(0, rerollIndex),
			entry,
			...constellations.slice(rerollIndex + 1),
		];
		focusedIndex = rerollIndex;
		isRerolling = false;
		stopMatchingPhrases();
		isMatching = false;
		showInput = false;

		history.replaceState(null, '', '#' + encodeAllToHash(constellations));

		// Redraw all constellations with focus on the re-rolled one
		const allResults = constellations.map(c => c.result);
		starField?.refocusConstellation(allResults, focusedIndex, constellations.map(c => c.color));
	}

	function handleReroll() {
		if (constellations.length === 0 || focusedIndex < 0) return;
		undoStack = [];
		redoStack = [];

		const targetEntry = constellations[focusedIndex];
		rerollIndex = focusedIndex;
		isRerolling = true;
		isMatching = true;
		matchProgress = 0;
		showInput = true;
		inputText = targetEntry.text;
		startMatchingPhrases();
		pendingText = targetEntry.text;

		// Add the current result's stars to the accumulated re-roll blacklist
		for (const pair of targetEntry.result.pairs) {
			rerollBlacklist.push(pair.star.idx);
		}

		// Combine all active constellation stars + accumulated re-roll history
		const usedStarIndices = [...getUsedStarIndices(), ...rerollBlacklist];
		const requestId = ++matchRequestId;
		startMatchTimeout();
		worker.postMessage({ type: 'match', payload: { text: targetEntry.text, usedStarIndices }, requestId });
	}

	function handleFocusConstellation(index: number) {
		if (showInput || isMatching) return;
		focusedIndex = index;
		const allResults = constellations.map(c => c.result);
		starField?.panToConstellation(allResults, index, constellations.map(c => c.color));
	}

	function handleDeleteConstellation(index: number, event: MouseEvent) {
		event.stopPropagation();
		undoStack = [];
		redoStack = [];
		constellations = constellations.filter((_, i) => i !== index);
		if (constellations.length === 0) {
			handleReset();
			return;
		}
		// Adjust focusedIndex
		if (focusedIndex >= constellations.length) {
			focusedIndex = constellations.length - 1;
		} else if (focusedIndex > index) {
			focusedIndex--;
		}
		history.replaceState(null, '', '#' + encodeAllToHash(constellations));
		const allResults = constellations.map(c => c.result);
		starField?.refocusConstellation(allResults, focusedIndex, constellations.map(c => c.color));
	}

	function handleAddAnother() {
		showInput = true;
		inputText = '';
	}

	function cancelAddMore() {
		if (showInput && constellations.length > 0 && !isMatching) {
			showInput = false;
			inputText = '';
		}
	}

	function handleReset() {
		matchRequestId++; // invalidate any in-flight request
		clearMatchTimeout();
		isMatching = false;
		isRerolling = false;
		stopMatchingPhrases();
		constellations = [];
		focusedIndex = -1;
		rerollBlacklist = [];
		undoStack = [];
		redoStack = [];
		showInput = true;
		inputText = '';
		// Clear hash
		history.replaceState(null, '', window.location.pathname);
		starField?.resetView();
		autoRotate = !reducedMotion;
		starField?.toggleAutoRotate(!reducedMotion);
	}

	// --- Undo/redo for vertex drags ---
	interface DragAction {
		constellationIndex: number;
		nodeIndex: number;
		oldStar: Star;
		newStar: Star;
	}
	let undoStack: DragAction[] = [];
	let redoStack: DragAction[] = [];

	function applyDragAction(action: DragAction, star: Star) {
		const entry = constellations[action.constellationIndex];
		if (!entry) return;
		const newPairs = entry.result.pairs.map(p =>
			p.nodeIndex === action.nodeIndex ? { ...p, star } : { ...p }
		);
		const newResult: MatchResult = { ...entry.result, pairs: newPairs };
		const newEntry: ConstellationEntry = { ...entry, result: newResult };
		constellations = [
			...constellations.slice(0, action.constellationIndex),
			newEntry,
			...constellations.slice(action.constellationIndex + 1),
		];
		history.replaceState(null, '', '#' + encodeAllToHash(constellations));
		starField?.redrawConstellations(constellations.map(c => c.result), constellations.map(c => c.color));
	}

	function handleUndo() {
		const action = undoStack.pop();
		if (!action) return;
		redoStack.push(action);
		applyDragAction(action, action.oldStar);
	}

	function handleRedo() {
		const action = redoStack.pop();
		if (!action) return;
		undoStack.push(action);
		applyDragAction(action, action.newStar);
	}

	let copied = $state(false);
	const reducedMotion = typeof window !== 'undefined'
		? window.matchMedia('(prefers-reduced-motion: reduce)').matches
		: false;
	let iauOverlay = $state(false);
	let autoRotate = $state(!reducedMotion);
	let starLabels = $state(false);
	let coordGrid = $state(false);
	let shootingStars = $state(!reducedMotion);
	let brightness = $state(1.0);
	let monoColor = $state(false);
	let showSun = $state(false);
	let globeView = $state(false);
	let settingsOpen = $state(false);
	let aboutOpen = $state(false);

	function handleToggleAutoRotate() {
		autoRotate = !autoRotate;
		starField?.toggleAutoRotate(autoRotate);
	}

	function handleToggleIAU() {
		iauOverlay = !iauOverlay;
		starField?.toggleIAUOverlay(iauOverlay);
	}

	function handleToggleStarLabels() {
		starLabels = !starLabels;
		starField?.toggleStarLabels(starLabels);
	}

	function handleToggleCoordGrid() {
		coordGrid = !coordGrid;
		starField?.toggleCoordinateGrid(coordGrid);
	}

	function handleToggleShootingStars() {
		shootingStars = !shootingStars;
		starField?.toggleShootingStars(shootingStars);
	}

	function handleBrightnessChange(e: Event) {
		brightness = parseFloat((e.target as HTMLInputElement).value);
		starField?.setBrightness(brightness);
	}

	function handleToggleMonoColor() {
		monoColor = !monoColor;
		starField?.setMonochrome(monoColor);
	}

	function handleToggleSun() {
		showSun = !showSun;
		starField?.toggleSun(showSun);
	}

	function handleToggleGlobeView() {
		globeView = !globeView;
		starField?.toggleGlobeView(globeView);
	}

	async function handleShare() {
		// Try native share (mobile) with image if supported
		if (navigator.share) {
			try {
				const blob = await starField?.captureImage();
				const shareData: ShareData = {
					title: 'Written in the Stars',
					url: window.location.href,
				};
				if (blob && navigator.canShare) {
					const file = new File([blob], 'constellation.png', { type: 'image/png' });
					const withFile = { ...shareData, files: [file] };
					if (navigator.canShare(withFile)) {
						shareData.files = [file];
					}
				}
				await navigator.share(shareData);
				return;
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') return;
				// Fall through to clipboard
			}
		}

		// Fallback: copy link to clipboard
		try {
			await navigator.clipboard.writeText(window.location.href);
		} catch {
			const tmp = document.createElement('input');
			tmp.value = window.location.href;
			document.body.appendChild(tmp);
			tmp.select();
			document.execCommand('copy');
			tmp.remove();
		}
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	async function handleSaveImage() {
		try {
			const blob = await starField?.captureImage();
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			const name = constellations[constellations.length - 1]?.name ?? 'constellation';
			a.download = `${name.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			errorMessage = 'Failed to save image. Please try again.';
			setTimeout(() => (errorMessage = ''), 4000);
		}
	}

	function handleVertexDrag(e: { constellationIndex: number; nodeIndex: number; newStar: Star }) {
		const { constellationIndex, nodeIndex, newStar } = e;
		const entry = constellations[constellationIndex];
		if (!entry) return;

		// Find the old star for undo
		const oldPair = entry.result.pairs.find(p => p.nodeIndex === nodeIndex);
		if (!oldPair) return;
		const oldStar = oldPair.star;

		// Skip if same star (no-op drag)
		if (oldStar.idx === newStar.idx) return;

		// Reject if the star is already used by any constellation (preserves uniqueness invariant)
		for (const c of constellations) {
			if (c.result.pairs.some(p => p.star.idx === newStar.idx)) return;
		}

		// Push to undo stack, clear redo
		undoStack.push({ constellationIndex, nodeIndex, oldStar, newStar });
		redoStack = [];

		applyDragAction({ constellationIndex, nodeIndex, oldStar, newStar }, newStar);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			handleSubmit();
		}
	}



	// --- Star search + info panel ---
	let selectedStar = $state<Star | null>(null);
	let selectedConstellation = $state<typeof CONSTELLATIONS[0] | null>(null);
	let searchQuery = $state('');
	let searchOpen = $state(false);
	let searchHighlight = $state(0);
	let searchInputEl: HTMLInputElement;
	let starClickedThisTick = false;

	// Selection history for back navigation
	interface SelectionState { star: Star | null; constellation: typeof CONSTELLATIONS[0] | null; }
	let selectionHistory = $state<SelectionState[]>([]);

	// --- Guided tour (first-run only) ---
	const TOUR_STEPS = [
		'Drag any vertex to snap it to a different star',
		'Try again for a completely different star placement',
		'Undo with Ctrl+Z, redo with Ctrl+Y',
	];
	let tourStep = $state(0);
	let tourSeen = $state(typeof localStorage !== 'undefined' && localStorage.getItem('starspelled-tour-seen') === '1');

	// Auto-focus search box when result overlay appears
	$effect(() => {
		if (!showInput && searchInputEl) {
			// Tick delay so the DOM is rendered before focus
			const t = setTimeout(() => searchInputEl?.focus(), 50);
			return () => clearTimeout(t);
		}
	});

	$effect(() => {
		if (!tourSeen && !showInput && constellations.length === 1 && tourStep === 0) {
			const timer = setTimeout(() => { tourStep = 1; }, 1200);
			return () => clearTimeout(timer);
		}
	});

	function advanceTour() {
		if (tourStep >= TOUR_STEPS.length) {
			dismissTour();
		} else {
			tourStep++;
		}
	}

	function dismissTour() {
		tourStep = 0;
		tourSeen = true;
		localStorage.setItem('starspelled-tour-seen', '1');
	}

	function pushSelection() {
		if (selectedStar || selectedConstellation) {
			selectionHistory = [...selectionHistory, { star: selectedStar, constellation: selectedConstellation }];
		}
	}

	function popSelection() {
		if (selectionHistory.length === 0) return;
		const prev = selectionHistory[selectionHistory.length - 1];
		selectionHistory = selectionHistory.slice(0, -1);
		selectedStar = prev.star;
		selectedConstellation = prev.constellation;
		starField?.clearStarHighlight();
		if (prev.star) {
			starField?.clearTempConstellation();
			starField?.highlightStar(prev.star);
			starField?.panToRaDec(prev.star.ra, prev.star.dec, 30);
		} else if (prev.constellation) {
			// Constellation lines may already be drawn; redraw to be safe
			starField?.drawTempConstellation(prev.constellation.name);
			starField?.panToIAUConstellation(prev.constellation.name);
		}
	}

	// Build search index of named stars (derived from reactive stars)
	let namedStars = $derived(stars.filter(s => s.name));
	// Build HIP lookup for constellation star resolution
	let starByHip = $derived.by(() => {
		const map = new Map<number, Star>();
		for (const s of stars) if (s.hip) map.set(s.hip, s);
		return map;
	});

	// Build HIP → constellation(s) reverse lookup
	const hipToConstellations = new Map<number, typeof CONSTELLATIONS[number][]>();
	for (const c of CONSTELLATIONS) {
		for (const [a, b] of c.lines) {
			for (const hip of [a, b]) {
				const list = hipToConstellations.get(hip);
				if (list) { if (!list.includes(c)) list.push(c); }
				else hipToConstellations.set(hip, [c]);
			}
		}
	}

	function getStarConstellations(star: Star): typeof CONSTELLATIONS[number][] {
		if (!star.hip) return [];
		return hipToConstellations.get(star.hip) || [];
	}

	interface SearchResult {
		type: 'star' | 'constellation';
		name: string;
		star?: Star;
		constellation?: typeof CONSTELLATIONS[0];
	}

	function getSearchResults(query: string): SearchResult[] {
		if (!query.trim()) return [];
		const q = query.toLowerCase();
		const results: SearchResult[] = [];
		// Stars by name
		for (const s of namedStars) {
			if (s.name!.toLowerCase().includes(q)) {
				results.push({ type: 'star', name: s.name!, star: s });
			}
			if (results.length >= 12) break;
		}
		// IAU constellations by name
		for (const c of CONSTELLATIONS) {
			if (c.name.toLowerCase().includes(q)) {
				results.push({ type: 'constellation', name: c.name, constellation: c });
			}
			if (results.length >= 20) break;
		}
		return results;
	}

	function handleSearchSelect(result: SearchResult) {
		if (result.type === 'star' && result.star) {
			selectedStar = result.star;
			selectedConstellation = null;
			starField?.clearTempConstellation();
			starField?.highlightStar(result.star);
			starField?.panToRaDec(result.star.ra, result.star.dec, 30);
		} else if (result.type === 'constellation' && result.constellation) {
			selectedConstellation = result.constellation;
			selectedStar = null;
			starField?.clearStarHighlight();
			starField?.drawTempConstellation(result.constellation.name);
			starField?.panToIAUConstellation(result.constellation.name);
		}
		searchQuery = '';
		searchOpen = false;
	}

	function handleStarClick(star: Star, _screenPos: { x: number; y: number }) {
		if (selectedStar && selectedStar.idx === star.idx) {
			selectedStar = null;
			starField?.clearStarHighlight();
			starClickedThisTick = true;
			requestAnimationFrame(() => { starClickedThisTick = false; });
			return;
		}
		selectedStar = star;
		selectedConstellation = null;
		starField?.clearTempConstellation();
		starField?.highlightStar(star);
		// Prevent the bubbling click event from immediately dismissing
		starClickedThisTick = true;
		requestAnimationFrame(() => { starClickedThisTick = false; });
	}

	function getConstellationStars(c: typeof CONSTELLATIONS[0]): Star[] {
		const hipSet = new Set<number>();
		for (const [a, b] of c.lines) { hipSet.add(a); hipSet.add(b); }
		const result: Star[] = [];
		for (const hip of hipSet) {
			const s = starByHip.get(hip);
			if (s) result.push(s);
		}
		return result.sort((a, b) => a.mag - b.mag);
	}

	function formatRA(ra: number): string {
		const hours = (ra / (Math.PI * 2)) * 24;
		const h = Math.floor(hours);
		const m = Math.floor((hours - h) * 60);
		const s = ((hours - h - m / 60) * 3600).toFixed(1);
		return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(4, '0')}s`;
	}

	function formatDec(dec: number): string {
		const deg = (dec * 180) / Math.PI;
		const sign = deg >= 0 ? '+' : '\u2212';
		const abs = Math.abs(deg);
		const d = Math.floor(abs);
		const m = Math.floor((abs - d) * 60);
		const s = ((abs - d - m / 60) * 3600).toFixed(0);
		return `${sign}${d}\u00b0 ${String(m).padStart(2, '0')}\u2032 ${String(s).padStart(2, '0')}\u2033`;
	}

	function spectralClass(ci?: number): string {
		if (ci === undefined) return 'Unknown';
		if (ci < -0.02) return 'O/B (blue)';
		if (ci < 0.15) return 'A (blue-white)';
		if (ci < 0.44) return 'F (white)';
		if (ci < 0.68) return 'G (yellow)';
		if (ci < 1.15) return 'K (orange)';
		return 'M (red)';
	}

	function starWikiUrl(star: Star): string | null {
		if (star.name) {
			return `https://en.wikipedia.org/wiki/${encodeURIComponent(star.name.replace(/ /g, '_'))}_(star)`;
		}
		if (star.hip) {
			return `https://simbad.u-strasbg.fr/simbad/sim-id?Ident=HIP+${star.hip}`;
		}
		return null;
	}

	function handleClickOutsideSettings(e: PointerEvent) {
		const target = e.target as HTMLElement;
		if (settingsOpen && !target.closest('.settings-container')) {
			settingsOpen = false;
		}
		// Close search dropdown when clicking outside
		if (searchOpen && !target.closest('.star-search-container')) {
			searchOpen = false;
		}
		// Dismiss star/constellation panel when clicking outside
		if ((selectedStar || selectedConstellation) && !starClickedThisTick && !target.closest('.star-panel') && !target.closest('.star-search-container')) {
			selectedStar = null;
			selectedConstellation = null;
			selectionHistory = [];
			starField?.clearStarHighlight();
			starField?.clearTempConstellation();
		}
	}

	function autoFocus(node: HTMLInputElement) {
		requestAnimationFrame(() => node.focus());
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement)?.tagName;
		const isInput = tag === 'INPUT' || tag === 'TEXTAREA';

		// Escape: dismiss overlays in order of priority
		if (e.key === 'Escape') {
			if (isMatching) { cancelMatch(); return; }
			if (showInput && constellations.length > 0) { cancelAddMore(); return; }
			if (aboutOpen) { aboutOpen = false; return; }
			if (searchOpen) { searchOpen = false; searchInputEl?.blur(); return; }
			if (selectedStar || selectedConstellation) {
				selectedStar = null;
				selectedConstellation = null;
				selectionHistory = [];
				starField?.clearStarHighlight();
				starField?.clearTempConstellation();
				return;
			}
			if (settingsOpen) { settingsOpen = false; return; }
		}

		// "/" to focus the main input (only when not already typing)
		if (e.key === '/' && !isInput) {
			e.preventDefault();
			if (showInput) {
				const el = document.getElementById('constellation-input') as HTMLInputElement | null;
				el?.focus();
			}
		}

		// Undo/redo — skip when focus is in an editable element
		if (!isInput && !(e.target as HTMLElement)?.isContentEditable) {
			if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
				e.preventDefault();
				handleUndo();
			}
			if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
				e.preventDefault();
				handleRedo();
			}
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="app" role="application" aria-label="Written in the Stars - constellation creator" onpointerdown={handleClickOutsideSettings}>
	{#await StarFieldPromise then StarFieldModule}
		{#if starsReady}
			<StarFieldModule.default {stars} bind:this={starField} onReady={handleStarFieldReady} onVertexDrag={handleVertexDrag} onStarClick={handleStarClick} />
		{/if}
	{/await}

	<!-- Top-left toolbar: settings, info, search -->
	<div class="top-bar">
		<div class="top-bar-buttons">
			<div class="settings-container">
				<button
					class="top-bar-btn"
					class:open={settingsOpen}
					onclick={() => settingsOpen = !settingsOpen}
					aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
					aria-expanded={settingsOpen}
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						{#if settingsOpen}
							<line x1="6" y1="6" x2="18" y2="18" />
							<line x1="18" y1="6" x2="6" y2="18" />
						{:else}
							<line x1="4" y1="7" x2="20" y2="7" />
							<line x1="4" y1="12" x2="20" y2="12" />
							<line x1="4" y1="17" x2="20" y2="17" />
						{/if}
					</svg>
				</button>

				{#if settingsOpen}
					<div class="settings-panel" role="menu">
						<button class="settings-item" class:active={autoRotate} onclick={handleToggleAutoRotate} role="menuitemcheckbox" aria-checked={autoRotate}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<path d="M21 12a9 9 0 1 1-3-6.7" />
								<polyline points="21 3 21 9 15 9" />
							</svg>
							<span>Auto-rotate</span>
						</button>
						<button class="settings-item" class:active={iauOverlay} onclick={handleToggleIAU} role="menuitemcheckbox" aria-checked={iauOverlay}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="5" cy="5" r="1.5" fill="currentColor" stroke="none"/>
								<circle cx="19" cy="4" r="1.5" fill="currentColor" stroke="none"/>
								<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
								<line x1="5" y1="5" x2="12" y2="12" />
								<line x1="19" y1="4" x2="12" y2="12" />
							</svg>
							<span>Constellations</span>
						</button>
						<button class="settings-item" class:active={starLabels} onclick={handleToggleStarLabels} role="menuitemcheckbox" aria-checked={starLabels}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
							</svg>
							<span>Star names</span>
						</button>
						<button class="settings-item" class:active={coordGrid} onclick={handleToggleCoordGrid} role="menuitemcheckbox" aria-checked={coordGrid}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="12" cy="12" r="9" />
								<line x1="12" y1="3" x2="12" y2="21" />
								<line x1="3" y1="12" x2="21" y2="12" />
								<ellipse cx="12" cy="12" rx="4" ry="9" />
							</svg>
							<span>Coordinates</span>
						</button>
						<button class="settings-item" class:active={shootingStars} onclick={handleToggleShootingStars} role="menuitemcheckbox" aria-checked={shootingStars}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<line x1="4" y1="20" x2="18" y2="6" />
								<polyline points="18 14 18 6 10 6" />
							</svg>
							<span>Shooting stars</span>
						</button>
						<button class="settings-item" class:active={!monoColor} onclick={handleToggleMonoColor} role="menuitemcheckbox" aria-checked={!monoColor}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="12" cy="12" r="9" />
								<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
							</svg>
							<span>Star color</span>
						</button>
						<button class="settings-item" class:active={showSun} onclick={handleToggleSun} role="menuitemcheckbox" aria-checked={showSun}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="12" cy="12" r="4" />
								<line x1="12" y1="2" x2="12" y2="5" />
								<line x1="12" y1="19" x2="12" y2="22" />
								<line x1="2" y1="12" x2="5" y2="12" />
								<line x1="19" y1="12" x2="22" y2="12" />
								<line x1="4.93" y1="4.93" x2="7.05" y2="7.05" />
								<line x1="16.95" y1="16.95" x2="19.07" y2="19.07" />
								<line x1="4.93" y1="19.07" x2="7.05" y2="16.95" />
								<line x1="16.95" y1="7.05" x2="19.07" y2="4.93" />
							</svg>
							<span>Sun</span>
						</button>
						<button class="settings-item" class:active={globeView} onclick={handleToggleGlobeView} role="menuitemcheckbox" aria-checked={globeView}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="12" cy="12" r="9" />
								<ellipse cx="12" cy="12" rx="9" ry="4" />
								<ellipse cx="12" cy="12" rx="4" ry="9" />
							</svg>
							<span>Globe</span>
						</button>
						<div class="settings-item slider-row">
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
								<circle cx="12" cy="12" r="6" />
								<circle cx="12" cy="12" r="9" opacity="0.4" />
							</svg>
							<label for="mag-slider">Brightness</label>
							<input
								id="mag-slider"
								type="range"
								min="0.2"
								max="2.0"
								step="0.1"
								value={brightness}
								oninput={handleBrightnessChange}
							/>
						</div>
					</div>
				{/if}
			</div>
			<button
				class="top-bar-btn"
				onclick={() => aboutOpen = !aboutOpen}
				aria-label="About this site"
			>
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
					<circle cx="12" cy="12" r="9" />
					<line x1="12" y1="11" x2="12" y2="16" />
					<circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="none" />
				</svg>
			</button>
		</div>

		<div class="star-search-container" role="search" onpointerdown={(e) => e.stopPropagation()}>
		<div class="star-search-input-wrap">
			<svg class="star-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<circle cx="11" cy="11" r="7" />
				<line x1="16.5" y1="16.5" x2="21" y2="21" />
			</svg>
			<input
				class="star-search-input"
				type="text"
				role="combobox"
				aria-expanded={searchOpen && !!searchQuery.trim()}
				aria-autocomplete="list"
				aria-controls="star-search-listbox"
				aria-activedescendant={searchOpen && searchQuery.trim() ? `star-search-option-${searchHighlight}` : undefined}
				bind:value={searchQuery}
				bind:this={searchInputEl}
				onfocus={() => searchOpen = true}
				oninput={() => { searchOpen = true; searchHighlight = 0; }}
				onkeydown={(e) => {
					const results = getSearchResults(searchQuery);
					if (e.key === 'ArrowDown') { e.preventDefault(); searchHighlight = Math.min(searchHighlight + 1, results.length - 1); }
					else if (e.key === 'ArrowUp') { e.preventDefault(); searchHighlight = Math.max(searchHighlight - 1, 0); }
					else if (e.key === 'Enter' && results.length > 0) { handleSearchSelect(results[searchHighlight]); searchInputEl?.blur(); }
					else if (e.key === 'Escape') { searchOpen = false; searchInputEl?.blur(); }
				}}
				placeholder="Search stars & constellations..."
				autocomplete="off"
			/>
			{#if searchQuery}
				<button class="star-search-clear" onclick={() => { searchQuery = ''; searchOpen = false; }} aria-label="Clear search">
					<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
					</svg>
				</button>
			{/if}
		</div>
		{#if searchOpen && searchQuery.trim()}
			{@const results = getSearchResults(searchQuery)}
			<div class="star-search-dropdown" role="listbox" id="star-search-listbox">
				{#if results.length === 0}
					<div class="star-search-empty">No results</div>
				{:else}
					{#each results as result, i}
						<button
							class="star-search-result"
							class:star-search-result-active={i === searchHighlight}
							id={`star-search-option-${i}`}
							role="option"
							aria-selected={i === searchHighlight}
							onclick={() => handleSearchSelect(result)}
							onpointerenter={() => { searchHighlight = i; }}
						>
							<span class="star-search-result-type">{result.type === 'star' ? 'Star' : 'IAU'}</span>
							<span class="star-search-result-name">{result.name}</span>
							{#if result.type === 'star' && result.star}
								<span class="star-search-result-mag">mag {result.star.mag.toFixed(1)}</span>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
	</div>

	{#if showInput}
		<div class="input-overlay" class:matching={isMatching}>
			<label for="constellation-input" class="sr-only">Enter text to map to stars</label>
			{#if inputRejectMsg}
				<div class="input-reject-msg">{inputRejectMsg}</div>
			{/if}
			<div class="input-sizer">
				<span class="input-measure" aria-hidden="true">{inputText || 'Search the stars...'}</span>
				<input
					id="constellation-input"
					type="text"
					bind:value={inputText}
					oninput={filterInput}
					onkeydown={handleKeydown}
					placeholder="Search the stars..."
					maxlength={30}
					disabled={isMatching || !starsReady}
					autocomplete="off"
					aria-describedby={isMatching ? 'matching-status' : undefined}
					use:autoFocus
				/>
			</div>
			{#if isMatching}
				<div id="matching-status" class="matching-indicator" role="status" aria-live="polite">
					<span class="matching-phrase">{matchingPhrase}...</span>
					<span class="matching-pct">{Math.round(matchProgress * 100)}%</span>
					<button class="cancel-match" onclick={cancelMatch} aria-label="Cancel matching">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
						</svg>
						esc
					</button>
				</div>
			{:else if constellations.length > 0}
				<button class="cancel-match go-back-btn" onclick={cancelAddMore} aria-label="Go back to constellation view">
					<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<polyline points="15 18 9 12 15 6" />
					</svg>
					Go back
				</button>
			{/if}
		</div>
	{/if}

	{#if starsError}
		<div class="error-toast error-toast-persistent" role="alert">{starsError}</div>
	{:else if errorMessage}
		<div class="error-toast" role="alert">{errorMessage}</div>
	{/if}

	<!-- Left-side info panel -->
	{#if selectedStar || selectedConstellation}
		<div class="star-panel" role="region" aria-label="Star info" onpointerdown={(e) => e.stopPropagation()}>
			<button class="star-panel-close" onclick={() => { selectedStar = null; selectedConstellation = null; selectionHistory = []; starField?.clearStarHighlight(); starField?.clearTempConstellation(); }} aria-label="Close info panel">
				<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
				</svg>
			</button>
			{#if selectionHistory.length > 0}
				<button class="star-panel-back" onclick={popSelection} aria-label="Go back">
					<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<polyline points="15 18 9 12 15 6" />
					</svg>
					{selectionHistory[selectionHistory.length - 1].constellation?.name || selectionHistory[selectionHistory.length - 1].star?.name || 'Back'}
				</button>
			{/if}

			{#if selectedStar}
				<div class="star-panel-name">{selectedStar.name || `HIP ${selectedStar.hip || selectedStar.id}`}</div>
				<div class="star-panel-rows">
					<div class="star-panel-row">
						<span class="star-panel-label">Magnitude</span>
						<span class="star-panel-value">{selectedStar.mag.toFixed(2)}</span>
					</div>
					<div class="star-panel-row">
						<span class="star-panel-label">Spectral</span>
						<span class="star-panel-value">{spectralClass(selectedStar.ci)}</span>
					</div>
					<div class="star-panel-row">
						<span class="star-panel-label">RA</span>
						<span class="star-panel-value">{formatRA(selectedStar.ra)}</span>
					</div>
					<div class="star-panel-row">
						<span class="star-panel-label">Dec</span>
						<span class="star-panel-value">{formatDec(selectedStar.dec)}</span>
					</div>
					{#if selectedStar.hip}
						<div class="star-panel-row">
							<span class="star-panel-label">HIP</span>
							<span class="star-panel-value">{selectedStar.hip}</span>
						</div>
					{/if}
				</div>
				{#if starWikiUrl(selectedStar)}
					<a class="star-panel-link" href={starWikiUrl(selectedStar)} target="_blank" rel="noopener noreferrer">
						{selectedStar.name ? 'Wikipedia' : 'SIMBAD'} &rarr;
					</a>
				{/if}
				{@const starConsts = getStarConstellations(selectedStar)}
				{#if starConsts.length > 0}
					<div class="star-panel-constellations">
						<span class="star-panel-label">In</span>
						{#each starConsts as c, i}
							<button class="star-panel-constellation-link" onclick={() => { pushSelection(); selectedConstellation = c; selectedStar = null; starField?.clearStarHighlight(); starField?.drawTempConstellation(c.name); starField?.panToIAUConstellation(c.name); }}>{c.name}</button>{#if i < starConsts.length - 1},&nbsp;{/if}
						{/each}
					</div>
				{/if}
			{:else if selectedConstellation}
				{@const cStars = getConstellationStars(selectedConstellation)}
				<div class="star-panel-name">{selectedConstellation.name}</div>
				<div class="star-panel-subtitle">IAU Constellation</div>
				<div class="star-panel-rows">
					<div class="star-panel-row">
						<span class="star-panel-label">Lines</span>
						<span class="star-panel-value">{selectedConstellation.lines.length}</span>
					</div>
					<div class="star-panel-row">
						<span class="star-panel-label">Stars</span>
						<span class="star-panel-value">{cStars.length}</span>
					</div>
					{#if cStars.length > 0}
						<div class="star-panel-row">
							<span class="star-panel-label">Brightest</span>
							<span class="star-panel-value">{cStars[0].name || `HIP ${cStars[0].hip}`} ({cStars[0].mag.toFixed(1)})</span>
						</div>
					{/if}
				</div>
				<div class="star-panel-star-list">
					<div class="star-panel-list-title">Notable stars</div>
					{#each cStars.filter((s: Star) => s.name).slice(0, 8) as s}
						<button class="star-panel-star-btn" onclick={() => { pushSelection(); selectedStar = s; selectedConstellation = null; starField?.highlightStar(s); starField?.panToRaDec(s.ra, s.dec, 30); }}>
							{s.name} <span class="star-panel-star-mag">({s.mag.toFixed(1)})</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- About modal -->
	{#if aboutOpen}
		<div class="about-backdrop" role="presentation" onpointerdown={() => aboutOpen = false}>
			<div class="about-modal" role="dialog" aria-modal="true" aria-label="About Written in the Stars" tabindex="-1" onpointerdown={(e) => e.stopPropagation()}>
				<button class="about-close" onclick={() => aboutOpen = false} aria-label="Close">
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
					</svg>
				</button>

				<h2 class="about-title">Starspelled</h2>
				<p class="about-text">
					Type anything and it becomes a constellation made from real stars. There are ~9,000 stars in here from an actual star catalog, so your constellations are mapped to real positions in the sky.
				</p>

				<div class="about-section">
					<h3 class="about-heading">How to use</h3>
					<ul class="about-list">
						<li>Type any word or phrase to create your constellation</li>
						<li>Drag vertices to snap them to nearby stars</li>
						<li>Search for real stars and IAU constellations</li>
						<li>Click any star to see its details</li>
						<li>Share your creation via the generated link</li>
					</ul>
				</div>

				<div class="about-footer">
					<span>Made by Josh Mosier</span>
					<a href="https://x.com/joshrmosier" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
						<svg viewBox="0 0 24 24" fill="currentColor" class="about-footer-icon"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
					</a>
					<a href="https://github.com/JoshuaMosier/written-in-the-stars" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
						<svg viewBox="0 0 24 24" fill="currentColor" class="about-footer-icon"><path d="M12 1.27a11 11 0 00-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2.16 2.16 0 01.64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 010-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 010 2.93c.74.74 1.2 1.74 1.2 2.84 0 4.31-2.58 5.23-5.06 5.5.45.37.82.92.82 2.02v3.03c0 .27.18.64.73.55A11 11 0 0012 1.27"/></svg>
					</a>
					<a href="https://joshmosier.com/" target="_blank" rel="noopener noreferrer" aria-label="Personal website">
						<svg viewBox="0 0 24 24" fill="currentColor" class="about-footer-icon"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
					</a>
					<span class="about-divider">&middot;</span>
					<a class="about-footer-neal" href="https://neal.fun/constellation-draw/" target="_blank" rel="noopener noreferrer">
						Inspired by
						<svg class="neal-logo" viewBox="0 0 333 89" aria-label="Neal.fun" role="img">
							<g transform="matrix(1,0,0,1,0,-217)">
								<g id="neal-art-about" transform="matrix(0.982301,0,0,1,0,216.559)">
									<clipPath id="_clip1_about"><rect x="0" y="0.441" width="339" height="88.559"/></clipPath>
									<g clip-path="url(#_clip1_about)">
										<g transform="matrix(1.01802,0,0,1,0,0.440917)">
											<path d="M179.26,84.007C176.96,81.747 176.07,76.927 178.18,74.297C183.16,68.077 191.43,71.877 192.24,79.047C192.69,83.027 191.63,85.037 187.57,85.707C184.85,86.157 181.33,86.037 179.26,84.007Z" fill="currentColor" fill-rule="nonzero"/>
										</g>
										<g transform="matrix(1.01802,0,0,1,714.649,-189.078)">
											<g transform="matrix(1,0,0,1,-701,190)">
												<path d="M36.15,58.807L36.61,57.157C39.59,41.047 42.28,24.867 43.46,8.487C44.21,5.597 51.69,4.367 52.79,7.027C53.24,8.127 52.12,12.007 51.88,13.397C48.49,33.287 46.14,53.237 43.68,73.257C43.43,75.317 42.85,81.757 41.67,83.057C38.98,86.017 35.48,85.057 33.83,81.667L17.14,25.417L9.16,83.377C6.97,88.437 0.27,89.607 0,82.717C4.33,61.707 7.01,40.387 10.93,19.297C11.62,15.597 12.2,11.117 13.22,7.567C13.73,5.797 14.49,4.407 16.5,4.207C20.87,3.787 22.19,8.187 23.18,11.537C26.04,21.207 27.96,31.377 30.66,41.127C32.31,47.077 34.33,52.897 36.14,58.797L36.15,58.807Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
											<g transform="matrix(1,0,0,1,-701,190)">
												<path d="M101.22,66.967C99.32,72.707 98.78,78.797 97.43,84.667C97.28,85.327 97.12,86.487 96.83,87.017C95.66,89.107 89.61,89.057 89.93,85.837L103.89,6.647C105.17,0.567 110.89,-0.903 114.17,4.787C115.15,6.487 115.58,8.587 116.03,10.487C118.31,20.067 119.75,30.747 121.41,40.517C123.86,54.907 126.16,69.367 128.28,83.797C126.73,87.677 121.5,87.607 120.41,83.387L117.61,65.167L101.22,66.977L101.22,66.967ZM116.49,58.437L109.12,18.597L102.29,60.097L116.49,58.437Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
											<g transform="matrix(0.999782,-0.0208841,0.0208841,0.999782,-701.901,191.491)">
												<path d="M70.56,11.777C68.82,21.707 68.73,31.837 67.61,41.837C71.7,42.777 75.97,41.737 80.07,42.017C82.52,42.187 85.19,43.097 86.01,45.677C86.63,47.627 85.94,49.817 83.74,50.127C80.87,50.537 77.6,49.997 74.72,49.947C72.44,49.907 70.16,50.017 67.88,49.957C67.47,49.947 66.81,49.597 66.59,49.937L62.82,75.397C64.64,75.487 66.44,75.607 68.27,75.597C71.57,75.567 80,74.427 81.67,78.227C82.24,79.517 81.87,80.777 80.91,81.767C79.13,83.627 77.7,83.017 75.45,83.137C69.58,83.447 61.41,84.267 55.85,82.277C54.32,81.727 53.73,81.327 53.77,79.547C54.05,68.517 57.78,55.807 59.29,44.667C60.8,33.527 61.12,22.367 62.85,11.337C63.06,9.967 63.51,6.097 64.29,5.207C64.49,4.977 64.75,4.777 65.03,4.657C65.95,4.687 67.05,4.407 67.91,4.387C72.16,4.247 77.69,4.107 81.92,4.387C83.42,4.487 87.16,5.057 87.87,6.547C88.58,8.037 87.26,11.747 85.56,12.087C83.46,12.507 79.76,11.837 77.5,11.747C75.24,11.667 72.89,11.627 70.58,11.747L70.56,11.777Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
											<g transform="matrix(1,0,0,1,-701,190)">
												<path d="M139.68,2.076C141.13,1.836 143.88,1.906 145.07,2.866C146.63,4.136 146.44,7.217 146.38,9.097C145.97,20.397 145.55,31.707 145.26,43.027C144.97,54.337 145.03,65.637 144.93,76.927C145.19,78.157 147.1,77.857 148.13,77.807C152.97,77.577 157.79,75.877 162.69,76.327C166.96,76.717 168.31,80.757 164.26,82.687L138.34,86.087C137.21,86.297 136.02,85.787 135.75,84.627C135.41,83.207 135.64,79.527 135.66,77.877C135.97,59.857 137.37,41.847 137.87,23.837C138.04,17.587 136.98,11.137 137.32,5.207C137.42,3.407 137.49,2.436 139.68,2.066L139.68,2.076Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
										</g>
										<g transform="matrix(1.01802,0,0,1,639.243,-186.628)">
											<g transform="matrix(0.999542,-0.0302536,0.0302536,0.999542,-630.24,198.142)">
												<path d="M319.41,58.807C319.76,58.847 319.566,58.416 319.54,58.217C317.444,41.903 317.26,24.509 314.771,7.958C314.582,2.21 322.107,0.507 323.361,7.958C323.614,9.462 323.421,11.498 323.561,13.108C325.291,31.808 326.77,52.077 329.39,70.687C329.89,74.277 331.17,78.857 331.22,82.347C331.28,87.267 326.05,87.197 323.68,83.967L293.77,24.697L299.68,83.817C298.31,90.637 291.65,89.357 290.66,82.867C289.77,77.067 290.08,70.527 289.71,64.627C288.74,48.877 287.07,33.167 286.21,17.407C286.02,13.947 285.52,9.297 285.65,5.987C285.81,1.677 290.35,2.607 292.57,4.777C294.47,6.637 297.75,14.267 299.09,17.067C302.53,24.257 305.62,31.617 309.1,38.777C312.38,45.537 316.01,52.117 319.41,58.817L319.41,58.807Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
											<g transform="matrix(1,0,0,1,-628,188.79)">
												<path d="M238.84,2.876C243.11,2.816 243.71,5.427 244.05,8.727C245.92,27.367 241.94,49.257 247.28,67.287C248.85,72.607 253.73,81.187 260.27,76.217C267.31,70.857 267.34,51.607 267.66,43.397C268.03,33.757 268.47,23.717 267.48,14.077C267.2,11.317 265.86,7.826 266.41,5.346C266.73,3.906 269.43,3.316 270.68,3.386C275.68,3.686 275.63,6.157 275.96,10.017C276.86,20.557 276.57,31.357 276.32,41.917C275.98,56.637 277.09,89.297 253.79,84.757C238.34,81.747 237.86,63.707 236.86,51.147C235.82,38.007 235.24,24.847 235.02,11.667C234.98,9.147 234.58,8.216 234.82,5.666C235.01,3.666 237.03,2.896 238.84,2.866L238.84,2.876Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
											<g transform="matrix(1,0,0,1,-629,188.79)">
												<path d="M207.52,7.527L209.76,27.057L225.51,27.127C228.66,27.907 230.56,32.437 226.57,33.637C221.97,35.017 214.45,33.577 210,34.087C208.78,34.227 208.95,34.787 208.99,35.847C209.26,42.347 210.41,49.197 210.83,55.767C211.12,60.287 211.19,64.887 211.38,69.427C211.53,73.157 212.1,77.537 211.76,81.227C211.49,84.227 208.09,85.177 205.62,84.027C204.06,83.297 203.89,82.207 203.66,80.637C202.63,73.657 203.22,65.807 202.91,58.707C202.17,42.087 199,25.387 198.47,8.917C198.42,7.487 198.23,3.747 198.91,2.697C200.33,0.507 206.5,1.197 208.9,1.067C212.57,0.867 223.52,-0.523 226.47,1.627C227.58,2.437 228.62,4.557 227.93,5.857C226.99,7.607 218.95,7.137 217.21,7.537L207.52,7.537L207.52,7.527Z" fill="currentColor" fill-rule="nonzero"/>
											</g>
										</g>
									</g>
								</g>
							</g>
						</svg>
					</a>
				</div>
			</div>
		</div>
	{/if}

	<div class="credits">
		<span class="credits-made-by">Made by Josh Mosier</span>
		<a href="https://x.com/joshrmosier" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
			<svg viewBox="0 0 24 24" fill="currentColor" class="credits-icon"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
		</a>
		<a href="https://github.com/JoshuaMosier/written-in-the-stars" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
			<svg viewBox="0 0 24 24" fill="currentColor" class="credits-icon"><path d="M12 1.27a11 11 0 00-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2.16 2.16 0 01.64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 010-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 010 2.93c.74.74 1.2 1.74 1.2 2.84 0 4.31-2.58 5.23-5.06 5.5.45.37.82.92.82 2.02v3.03c0 .27.18.64.73.55A11 11 0 0012 1.27"/></svg>
		</a>
		<a href="https://joshmosier.com/" target="_blank" rel="noopener noreferrer" aria-label="Personal website">
			<svg viewBox="0 0 24 24" fill="currentColor" class="credits-icon"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
		</a>
		<span class="credits-divider">&middot;</span>
		<a class="credits-neal" href="https://neal.fun/constellation-draw/" target="_blank" rel="noopener noreferrer">
			Inspired by
			<svg class="neal-logo" viewBox="0 0 333 89" aria-label="Neal.fun" role="img">
				<g transform="matrix(1,0,0,1,0,-217)">
					<g id="neal-art" transform="matrix(0.982301,0,0,1,0,216.559)">
						<clipPath id="_clip1"><rect x="0" y="0.441" width="339" height="88.559"/></clipPath>
						<g clip-path="url(#_clip1)">
							<g transform="matrix(1.01802,0,0,1,0,0.440917)">
								<path d="M179.26,84.007C176.96,81.747 176.07,76.927 178.18,74.297C183.16,68.077 191.43,71.877 192.24,79.047C192.69,83.027 191.63,85.037 187.57,85.707C184.85,86.157 181.33,86.037 179.26,84.007Z" fill="currentColor" fill-rule="nonzero"/>
							</g>
							<g transform="matrix(1.01802,0,0,1,714.649,-189.078)">
								<g transform="matrix(1,0,0,1,-701,190)">
									<path d="M36.15,58.807L36.61,57.157C39.59,41.047 42.28,24.867 43.46,8.487C44.21,5.597 51.69,4.367 52.79,7.027C53.24,8.127 52.12,12.007 51.88,13.397C48.49,33.287 46.14,53.237 43.68,73.257C43.43,75.317 42.85,81.757 41.67,83.057C38.98,86.017 35.48,85.057 33.83,81.667L17.14,25.417L9.16,83.377C6.97,88.437 0.27,89.607 0,82.717C4.33,61.707 7.01,40.387 10.93,19.297C11.62,15.597 12.2,11.117 13.22,7.567C13.73,5.797 14.49,4.407 16.5,4.207C20.87,3.787 22.19,8.187 23.18,11.537C26.04,21.207 27.96,31.377 30.66,41.127C32.31,47.077 34.33,52.897 36.14,58.797L36.15,58.807Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
								<g transform="matrix(1,0,0,1,-701,190)">
									<path d="M101.22,66.967C99.32,72.707 98.78,78.797 97.43,84.667C97.28,85.327 97.12,86.487 96.83,87.017C95.66,89.107 89.61,89.057 89.93,85.837L103.89,6.647C105.17,0.567 110.89,-0.903 114.17,4.787C115.15,6.487 115.58,8.587 116.03,10.487C118.31,20.067 119.75,30.747 121.41,40.517C123.86,54.907 126.16,69.367 128.28,83.797C126.73,87.677 121.5,87.607 120.41,83.387L117.61,65.167L101.22,66.977L101.22,66.967ZM116.49,58.437L109.12,18.597L102.29,60.097L116.49,58.437Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
								<g transform="matrix(0.999782,-0.0208841,0.0208841,0.999782,-701.901,191.491)">
									<path d="M70.56,11.777C68.82,21.707 68.73,31.837 67.61,41.837C71.7,42.777 75.97,41.737 80.07,42.017C82.52,42.187 85.19,43.097 86.01,45.677C86.63,47.627 85.94,49.817 83.74,50.127C80.87,50.537 77.6,49.997 74.72,49.947C72.44,49.907 70.16,50.017 67.88,49.957C67.47,49.947 66.81,49.597 66.59,49.937L62.82,75.397C64.64,75.487 66.44,75.607 68.27,75.597C71.57,75.567 80,74.427 81.67,78.227C82.24,79.517 81.87,80.777 80.91,81.767C79.13,83.627 77.7,83.017 75.45,83.137C69.58,83.447 61.41,84.267 55.85,82.277C54.32,81.727 53.73,81.327 53.77,79.547C54.05,68.517 57.78,55.807 59.29,44.667C60.8,33.527 61.12,22.367 62.85,11.337C63.06,9.967 63.51,6.097 64.29,5.207C64.49,4.977 64.75,4.777 65.03,4.657C65.95,4.687 67.05,4.407 67.91,4.387C72.16,4.247 77.69,4.107 81.92,4.387C83.42,4.487 87.16,5.057 87.87,6.547C88.58,8.037 87.26,11.747 85.56,12.087C83.46,12.507 79.76,11.837 77.5,11.747C75.24,11.667 72.89,11.627 70.58,11.747L70.56,11.777Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
								<g transform="matrix(1,0,0,1,-701,190)">
									<path d="M139.68,2.076C141.13,1.836 143.88,1.906 145.07,2.866C146.63,4.136 146.44,7.217 146.38,9.097C145.97,20.397 145.55,31.707 145.26,43.027C144.97,54.337 145.03,65.637 144.93,76.927C145.19,78.157 147.1,77.857 148.13,77.807C152.97,77.577 157.79,75.877 162.69,76.327C166.96,76.717 168.31,80.757 164.26,82.687L138.34,86.087C137.21,86.297 136.02,85.787 135.75,84.627C135.41,83.207 135.64,79.527 135.66,77.877C135.97,59.857 137.37,41.847 137.87,23.837C138.04,17.587 136.98,11.137 137.32,5.207C137.42,3.407 137.49,2.436 139.68,2.066L139.68,2.076Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
							</g>
							<g transform="matrix(1.01802,0,0,1,639.243,-186.628)">
								<g transform="matrix(0.999542,-0.0302536,0.0302536,0.999542,-630.24,198.142)">
									<path d="M319.41,58.807C319.76,58.847 319.566,58.416 319.54,58.217C317.444,41.903 317.26,24.509 314.771,7.958C314.582,2.21 322.107,0.507 323.361,7.958C323.614,9.462 323.421,11.498 323.561,13.108C325.291,31.808 326.77,52.077 329.39,70.687C329.89,74.277 331.17,78.857 331.22,82.347C331.28,87.267 326.05,87.197 323.68,83.967L293.77,24.697L299.68,83.817C298.31,90.637 291.65,89.357 290.66,82.867C289.77,77.067 290.08,70.527 289.71,64.627C288.74,48.877 287.07,33.167 286.21,17.407C286.02,13.947 285.52,9.297 285.65,5.987C285.81,1.677 290.35,2.607 292.57,4.777C294.47,6.637 297.75,14.267 299.09,17.067C302.53,24.257 305.62,31.617 309.1,38.777C312.38,45.537 316.01,52.117 319.41,58.817L319.41,58.807Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
								<g transform="matrix(1,0,0,1,-628,188.79)">
									<path d="M238.84,2.876C243.11,2.816 243.71,5.427 244.05,8.727C245.92,27.367 241.94,49.257 247.28,67.287C248.85,72.607 253.73,81.187 260.27,76.217C267.31,70.857 267.34,51.607 267.66,43.397C268.03,33.757 268.47,23.717 267.48,14.077C267.2,11.317 265.86,7.826 266.41,5.346C266.73,3.906 269.43,3.316 270.68,3.386C275.68,3.686 275.63,6.157 275.96,10.017C276.86,20.557 276.57,31.357 276.32,41.917C275.98,56.637 277.09,89.297 253.79,84.757C238.34,81.747 237.86,63.707 236.86,51.147C235.82,38.007 235.24,24.847 235.02,11.667C234.98,9.147 234.58,8.216 234.82,5.666C235.01,3.666 237.03,2.896 238.84,2.866L238.84,2.876Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
								<g transform="matrix(1,0,0,1,-629,188.79)">
									<path d="M207.52,7.527L209.76,27.057L225.51,27.127C228.66,27.907 230.56,32.437 226.57,33.637C221.97,35.017 214.45,33.577 210,34.087C208.78,34.227 208.95,34.787 208.99,35.847C209.26,42.347 210.41,49.197 210.83,55.767C211.12,60.287 211.19,64.887 211.38,69.427C211.53,73.157 212.1,77.537 211.76,81.227C211.49,84.227 208.09,85.177 205.62,84.027C204.06,83.297 203.89,82.207 203.66,80.637C202.63,73.657 203.22,65.807 202.91,58.707C202.17,42.087 199,25.387 198.47,8.917C198.42,7.487 198.23,3.747 198.91,2.697C200.33,0.507 206.5,1.197 208.9,1.067C212.57,0.867 223.52,-0.523 226.47,1.627C227.58,2.437 228.62,4.557 227.93,5.857C226.99,7.607 218.95,7.137 217.21,7.537L207.52,7.537L207.52,7.527Z" fill="currentColor" fill-rule="nonzero"/>
								</g>
							</g>
						</g>
					</g>
				</g>
			</svg>
		</a>
	</div>

	{#if constellations.length > 0}
		<div class="result-overlay" class:dimmed={showInput} role="region" aria-label="Your constellations">
			{#each constellations as entry, i}
				<div class="constellation-card" class:focused={i === focusedIndex && !showInput}>
				<div class="delete-spacer" aria-hidden="true"></div>
				<button
					class="constellation-entry"
					class:focused={i === focusedIndex && !showInput}
					onclick={() => handleFocusConstellation(i)}
					disabled={showInput || isMatching}
				>
					<div class="constellation-name" style="color: {entry.color}; text-shadow: -1px -1px 2px rgba(0,0,0,0.9), 1px -1px 2px rgba(0,0,0,0.9), -1px 1px 2px rgba(0,0,0,0.9), 1px 1px 2px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6), 0 0 14px {entry.color}70, 0 0 28px {entry.color}35;">{entry.name}</div>
					<div class="constellation-info">
						<span class="catalog-id">{entry.catalogId}</span>
						<span class="separator" aria-hidden="true">·</span>
						<span class="star-count">{entry.starCount} stars</span>
					</div>
				</button>
				{#if !showInput && !isMatching}
					<div class="color-picker-wrapper">
						<button
							class="color-picker-btn"
							onclick={(e) => { e.stopPropagation(); colorPickerOpen = colorPickerOpen === i ? null : i; }}
							aria-label="Change color for {entry.name}"
						>
							<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
								<circle cx="12" cy="12" r="5" fill={entry.color} stroke="none" />
								<circle cx="12" cy="12" r="8" />
							</svg>
						</button>
						{#if colorPickerOpen === i}
							<div class="hue-ring-backdrop" onclick={() => colorPickerOpen = null} role="none"></div>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hue-ring-container"
								onpointerdown={(e) => handleRingStart(e, i)}
								onpointermove={(e) => handleRingMove(e, i)}
								onpointerup={handleRingEnd}
							>
								<div class="hue-ring"></div>
								{#if hexToHue(entry.color) !== null}
									<div class="hue-ring-indicator" style="transform: rotate({hexToHue(entry.color)}deg)">
										<div class="hue-ring-dot" style="background: {entry.color}; box-shadow: 0 0 6px {entry.color};"></div>
									</div>
								{/if}
								<button
									class="hue-ring-center"
									onclick={() => { updateConstellationColor(i, '#ffffff'); colorPickerOpen = null; }}
									aria-label="Reset to white"
								></button>
							</div>
						{/if}
					</div>
					<button
						class="delete-btn"
						onclick={(e) => handleDeleteConstellation(i, e)}
						aria-label="Delete {entry.name}"
					>
						<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<polyline points="3 6 5 6 21 6" />
							<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
							<path d="M10 11v6" />
							<path d="M14 11v6" />
							<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
						</svg>
					</button>
				{/if}
			</div>
			{/each}
			{#if !showInput}
				<div class="result-actions" role="toolbar" aria-label="Constellation actions">
					<button class="reset-btn" onclick={handleReroll} disabled={isRerolling} aria-label="Try again for a different constellation placement">
						{isRerolling ? 'Trying...' : 'Try again'}
					</button>
					<button class="reset-btn" onclick={handleShare} aria-label={copied ? 'Link copied to clipboard' : 'Copy shareable link'}>
						{copied ? 'Copied!' : 'Share'}
					</button>
					<button class="reset-btn" onclick={handleSaveImage} aria-label="Save constellation as image">Save image</button>
					<button class="reset-btn" onclick={handleAddAnother} aria-label="Add another constellation">Add more</button>
					<button class="reset-btn" onclick={handleReset} aria-label="Clear all constellations">Clear all</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if tourStep >= 1 && tourStep <= TOUR_STEPS.length}
		<div class="tour-tooltip" role="status" aria-live="polite">
			<div class="tour-header">
				<span class="tour-step">{tourStep}/{TOUR_STEPS.length}</span>
				<button class="tour-dismiss" onclick={dismissTour} aria-label="Dismiss tour">
					<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
						<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
					</svg>
				</button>
			</div>
			<div class="tour-text">{TOUR_STEPS[tourStep - 1]}</div>
			<button class="tour-next" onclick={advanceTour}>
				{tourStep < TOUR_STEPS.length ? 'Next' : 'Got it'}
			</button>
		</div>
	{/if}
</div>

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.app {
		position: relative;
		width: 100vw;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
	}

	.input-overlay {
		position: absolute;
		bottom: 33%;
		left: 50%;
		transform: translateX(-50%);
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.input-overlay.matching input {
		opacity: 0.6;
		pointer-events: none;
	}

	.input-sizer {
		display: inline-grid;
		align-items: center;
		min-width: 320px;
		max-width: 90vw;
	}

	.input-sizer::after,
	.input-sizer > .input-measure {
		display: none;
	}

	.input-sizer > input,
	.input-sizer > .input-measure {
		grid-area: 1 / 1;
		font-size: 24px;
		font-family: inherit;
		padding: 16px 28px;
		letter-spacing: 2px;
		white-space: pre;
	}

	.input-sizer > .input-measure {
		display: inline-block;
		visibility: hidden;
		pointer-events: none;
		text-align: center;
	}

	.input-overlay input {
		background: rgba(0, 0, 0, 0.2);
		backdrop-filter: blur(8px);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		color: #fff;
		font-size: 24px;
		font-family: inherit;
		padding: 16px 28px;
		width: 100%;
		text-align: center;
		letter-spacing: 2px;
		box-sizing: border-box;
		outline: none;
		transition: border-color 0.2s;
	}

	.input-overlay input::placeholder {
		color: rgba(255, 255, 255, 0.5);
	}

	.input-overlay input:focus {
		border-color: rgba(255, 215, 0, 0.4);
	}

	.input-overlay input:focus-visible {
		box-shadow: 0 0 0 2px rgba(255, 215, 0, 0.3);
	}

	.input-overlay :global(input.shake) {
		animation: input-shake 0.3s ease-out;
	}

	@keyframes input-shake {
		0%, 100% { transform: translateX(0); }
		20% { transform: translateX(-4px); }
		40% { transform: translateX(4px); }
		60% { transform: translateX(-3px); }
		80% { transform: translateX(2px); }
	}

	.input-reject-msg {
		position: absolute;
		bottom: 100%;
		margin-bottom: 8px;
		color: rgba(255, 150, 150, 0.9);
		font-size: 13px;
		letter-spacing: 0.5px;
		white-space: nowrap;
		pointer-events: none;
		animation: reject-fade-in 0.2s ease-out;
	}

	@keyframes reject-fade-in {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.matching-indicator {
		position: absolute;
		top: 100%;
		margin-top: 12px;
		color: rgba(255, 215, 0, 0.85);
		font-size: 15px;
		letter-spacing: 3px;
		text-transform: uppercase;
		background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.85) 40%, transparent 100%);
		padding: 12px 32px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.matching-pct {
		font-size: 12px;
		letter-spacing: 2px;
		color: rgba(255, 215, 0, 0.5);
		font-variant-numeric: tabular-nums;
	}

	.cancel-match {
		margin-top: 4px;
		background: none;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		color: rgba(255, 255, 255, 0.45);
		font-size: 11px;
		letter-spacing: 1.5px;
		text-transform: uppercase;
		padding: 4px 10px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 5px;
		transition: color 0.2s, border-color 0.2s;
	}

	.cancel-match:hover {
		color: rgba(255, 255, 255, 0.8);
		border-color: rgba(255, 255, 255, 0.3);
	}

	.go-back-btn {
		margin-top: 8px;
		background: rgba(0, 0, 0, 0.6);
		padding: 8px 16px;
		font-size: 12px;
		display: inline-flex;
		align-items: center;
		align-self: center;
		gap: 5px;
	}

	.error-toast {
		position: absolute;
		top: 24px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		background: rgba(200, 50, 50, 0.35);
		border: 1px solid rgba(200, 50, 50, 0.3);
		color: rgba(255, 150, 150, 0.9);
		padding: 10px 24px;
		border-radius: 8px;
		font-size: 14px;
		letter-spacing: 0.5px;
		animation: toast-in 0.3s ease-out;
	}

	.error-toast-persistent {
		animation: none;
	}

	@keyframes toast-in {
		from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	.result-overlay {
		position: absolute;
		bottom: 48px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		transition: opacity 0.3s;
		width: 100%;
		max-width: 100vw;
		padding: 0 16px;
		box-sizing: border-box;
	}

	.result-overlay.dimmed {
		opacity: 0;
		pointer-events: none;
	}

	.constellation-card {
		position: relative;
		display: flex;
		align-items: center;
	}

	.constellation-entry {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		opacity: 0.4;
		transition: opacity 0.3s;
		background: none;
		border: none;
		padding: 4px 12px;
		cursor: pointer;
		font-family: inherit;
		border-radius: 6px;
	}

	.constellation-entry:hover:not(:disabled) {
		opacity: 0.7;
	}

	.constellation-entry:disabled {
		cursor: default;
	}

	.constellation-entry.focused {
		opacity: 1;
	}

	.delete-spacer {
		width: 56px;
		flex-shrink: 0;
	}

	.color-picker-wrapper {
		position: relative;
		flex-shrink: 0;
		margin-left: 4px;
	}

	.color-picker-btn {
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.35);
		cursor: pointer;
		padding: 5px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: opacity 0.2s;
		opacity: 0;
	}

	.color-picker-btn:hover {
		background: rgba(255, 255, 255, 0.12);
		border-color: rgba(255, 255, 255, 0.2);
	}

	.constellation-card:hover .color-picker-btn,
	.color-picker-btn:focus-visible {
		opacity: 1;
	}

	.hue-ring-backdrop {
		position: fixed;
		inset: 0;
		z-index: 99;
	}

	.hue-ring-container {
		position: absolute;
		width: 80px;
		height: 80px;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 100;
		touch-action: none;
		animation: ring-appear 0.15s ease-out;
	}

	@keyframes ring-appear {
		from { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
		to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
	}

	.hue-ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: conic-gradient(
			hsl(0, 100%, 50%),
			hsl(60, 100%, 50%),
			hsl(120, 100%, 50%),
			hsl(180, 100%, 50%),
			hsl(240, 100%, 50%),
			hsl(300, 100%, 50%),
			hsl(360, 100%, 50%)
		);
		-webkit-mask: radial-gradient(circle, transparent 55%, black 60%);
		mask: radial-gradient(circle, transparent 55%, black 60%);
		cursor: crosshair;
	}

	.hue-ring-indicator {
		position: absolute;
		top: 0;
		left: 50%;
		width: 0;
		height: 50%;
		transform-origin: bottom center;
		pointer-events: none;
	}

	.hue-ring-dot {
		position: absolute;
		top: 2px;
		left: -6px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid white;
	}

	.hue-ring-center {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: #ffffff;
		border: 2px solid rgba(255, 255, 255, 0.25);
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.hue-ring-center:hover {
		border-color: rgba(255, 255, 255, 0.6);
	}

	.delete-btn {
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.35);
		cursor: pointer;
		padding: 5px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color 0.2s, background 0.2s, border-color 0.2s, opacity 0.2s;
		opacity: 0;
		margin-left: 4px;
		flex-shrink: 0;
	}

	.constellation-card:hover .delete-btn,
	.delete-btn:focus-visible {
		opacity: 1;
	}

	.delete-btn:hover {
		color: rgba(255, 100, 100, 0.85);
		background: rgba(255, 100, 100, 0.1);
		border-color: rgba(255, 100, 100, 0.25);
	}

	.delete-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px rgba(255, 100, 100, 0.4);
	}

	.constellation-name {
		font-size: 28px;
		letter-spacing: 6px;
	}

	.constellation-entry:not(.focused) .constellation-name {
		font-size: 16px;
		letter-spacing: 4px;
	}

	.constellation-info {
		font-size: 13px;
		color: rgba(255, 255, 255, 0.4);
		letter-spacing: 2px;
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.constellation-entry:not(.focused) .constellation-info {
		font-size: 11px;
	}

	.separator {
		opacity: 0.5;
	}

	.result-actions {
		display: flex;
		gap: 10px;
		margin-top: 12px;
		flex-wrap: wrap;
		justify-content: center;
		padding: 0 8px;
	}

	.reset-btn {
		background: rgba(0, 0, 0, 0.7);
		border: 1px solid rgba(255, 255, 255, 0.15);
		color: rgba(255, 255, 255, 0.5);
		padding: 8px 20px;
		border-radius: 6px;
		font-size: 13px;
		letter-spacing: 1px;
		cursor: pointer;
		font-family: inherit;
		transition: all 0.2s;
	}

	.reset-btn:hover:not(:disabled) {
		border-color: rgba(255, 215, 0, 0.3);
		color: rgba(255, 215, 0, 0.7);
	}

	.reset-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px rgba(255, 215, 0, 0.4);
	}

	.reset-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.credits {
		position: absolute;
		bottom: 14px;
		right: 16px;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		letter-spacing: 0.5px;
	}

	.credits-made-by {
		color: rgba(255, 255, 255, 0.35);
	}

	.credits a {
		color: rgba(255, 255, 255, 0.35);
		text-decoration: none;
		transition: color 0.2s;
		display: flex;
	}

	.credits a:hover {
		color: rgba(255, 255, 255, 0.65);
	}

	.credits-icon {
		width: 14px;
		height: 14px;
	}

	.credits-divider {
		color: rgba(255, 255, 255, 0.15);
	}

	.credits-neal {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.neal-logo {
		height: 14px;
		width: auto;
	}

	.top-bar {
		position: absolute;
		top: 16px;
		left: 16px;
		z-index: 15;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.top-bar-buttons {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.settings-container {
		position: relative;
		z-index: 10;
	}

	.top-bar-btn {
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.12);
		color: rgba(255, 255, 255, 0.4);
		border-radius: 8px;
		padding: 8px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.top-bar-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.7);
		border-color: rgba(255, 255, 255, 0.25);
	}

	.top-bar-btn.open {
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.7);
		border-color: rgba(255, 255, 255, 0.25);
	}

	.top-bar-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px rgba(170, 200, 255, 0.5);
	}

	.settings-panel {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		background: rgba(0, 0, 0, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 10px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		animation: panel-in 0.15s ease-out;
		white-space: nowrap;
	}

	@keyframes panel-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		*, *::before, *::after {
			animation-duration: 0.01ms !important;
			transition-duration: 0.01ms !important;
		}
	}

	.settings-item {
		display: flex;
		align-items: center;
		gap: 10px;
		background: none;
		border: none;
		border-radius: 6px;
		padding: 8px 14px 8px 10px;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		letter-spacing: 0.5px;
		color: rgba(255, 255, 255, 0.4);
		transition: all 0.15s;
		white-space: nowrap;
	}

	.settings-item:hover {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(255, 255, 255, 0.7);
	}

	.settings-item.active {
		color: rgba(170, 200, 255, 0.85);
	}

	.settings-item:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px rgba(170, 200, 255, 0.4);
	}

	.slider-row {
		cursor: default;
	}

	.slider-row label {
		font-size: 13px;
		letter-spacing: 0.5px;
		color: rgba(255, 255, 255, 0.4);
		cursor: default;
		white-space: nowrap;
	}

	.slider-row input[type="range"] {
		-webkit-appearance: none;
		appearance: none;
		width: 64px;
		height: 2px;
		background: rgba(255, 255, 255, 0.15);
		border-radius: 2px;
		outline: none;
		margin: 0 0 0 auto;
		padding: 0;
	}

	.slider-row input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: rgba(170, 200, 255, 0.7);
		cursor: pointer;
		border: none;
	}

	.slider-row input[type="range"]::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: rgba(170, 200, 255, 0.7);
		cursor: pointer;
		border: none;
	}

	/* Mobile adjustments */
	@media (max-width: 480px) {
		.input-overlay {
			bottom: 15%;
		}

		.input-sizer {
			display: contents;
		}

		.input-sizer > .input-measure {
			display: none;
		}

		.input-overlay input {
			font-size: 18px;
			padding: 14px 20px;
			letter-spacing: 1.5px;
			width: 85vw;
			max-width: 85vw;
		}

		.constellation-name {
			font-size: 22px;
			letter-spacing: 4px;
		}

		.constellation-entry:not(.focused) .constellation-name {
			font-size: 14px;
			letter-spacing: 3px;
		}

		.constellation-info {
			font-size: 11px;
			letter-spacing: 1.5px;
		}

		.delete-btn,
		.color-picker-btn {
			opacity: 1;
		}

		.result-actions {
			gap: 8px;
		}

		.reset-btn {
			padding: 8px 14px;
			font-size: 12px;
		}

		.result-overlay {
			bottom: 32px;
		}

		.top-bar {
			top: env(safe-area-inset-top, 16px);
			left: env(safe-area-inset-left, 16px);
		}
	}

	@media (max-width: 360px) {
		.result-actions {
			gap: 6px;
		}

		.reset-btn {
			padding: 7px 10px;
			font-size: 11px;
		}

		.constellation-name {
			font-size: 18px;
			letter-spacing: 3px;
		}
	}

	/* Star search bar (inside top-bar) */
	.star-search-container {
		position: relative;
		z-index: 15;
		width: 260px;
	}

	.star-search-input-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.star-search-icon {
		position: absolute;
		left: 10px;
		z-index: 1;
		color: rgba(255, 255, 255, 0.3);
		pointer-events: none;
	}

	.star-search-input {
		width: 100%;
		height: 36px;
		box-sizing: border-box;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 8px;
		color: #fff;
		font-size: 13px;
		font-family: inherit;
		padding: 0 28px 0 30px;
		letter-spacing: 0.5px;
		outline: none;
		transition: border-color 0.2s, background 0.2s;
	}

	.star-search-input::placeholder {
		color: rgba(255, 255, 255, 0.3);
	}

	.star-search-input:focus {
		border-color: rgba(255, 215, 0, 0.3);
	}

	.star-search-clear {
		position: absolute;
		right: 6px;
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.3);
		cursor: pointer;
		padding: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: color 0.15s;
	}

	.star-search-clear:hover {
		color: rgba(255, 255, 255, 0.7);
	}

	.star-search-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		margin-top: 4px;
		background: rgba(0, 0, 0, 0.9);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		max-height: 280px;
		overflow-y: auto;
		animation: panel-in 0.12s ease-out;
	}

	.star-search-empty {
		padding: 12px 14px;
		font-size: 12px;
		color: rgba(255, 255, 255, 0.3);
		letter-spacing: 0.5px;
	}

	.star-search-result {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: none;
		border: none;
		padding: 8px 12px;
		cursor: pointer;
		font-family: inherit;
		text-align: left;
		color: rgba(255, 255, 255, 0.7);
		transition: background 0.1s;
	}

	.star-search-result:hover,
	.star-search-result-active {
		background: rgba(255, 255, 255, 0.06);
	}

	.star-search-result-active {
		outline: 1px solid rgba(255, 215, 0, 0.3);
		outline-offset: -1px;
	}

	.star-search-result:first-child {
		border-radius: 8px 8px 0 0;
	}

	.star-search-result:last-child {
		border-radius: 0 0 8px 8px;
	}

	.star-search-result-type {
		font-size: 9px;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: rgba(170, 200, 255, 0.5);
		background: rgba(170, 200, 255, 0.08);
		padding: 2px 5px;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.star-search-result-name {
		font-size: 13px;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.star-search-result-mag {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.3);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	/* Left-side info panel */
	.star-panel {
		position: absolute;
		top: 56px;
		left: 16px;
		z-index: 14;
		width: 260px;
		background: rgba(0, 0, 0, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 10px;
		padding: 14px 16px;
		animation: panel-in 0.15s ease-out;
	}

	.star-panel-close {
		position: absolute;
		top: 10px;
		right: 10px;
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.3);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color 0.15s;
	}

	.star-panel-close:hover {
		color: rgba(255, 255, 255, 0.7);
	}

	.star-panel-back {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		color: rgba(170, 200, 255, 0.5);
		font-family: inherit;
		font-size: 11px;
		letter-spacing: 0.5px;
		cursor: pointer;
		padding: 0;
		margin-bottom: 8px;
		transition: color 0.15s;
	}

	.star-panel-back:hover {
		color: rgba(170, 200, 255, 0.9);
	}

	.star-panel-name {
		font-size: 16px;
		letter-spacing: 1px;
		color: rgba(255, 215, 0, 0.9);
		margin-bottom: 4px;
		padding-right: 20px;
	}

	.star-panel-subtitle {
		font-size: 11px;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: rgba(170, 200, 255, 0.5);
		margin-bottom: 10px;
	}

	.star-panel-rows {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 8px;
	}

	.star-panel-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.star-panel-label {
		font-size: 11px;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.35);
		flex-shrink: 0;
	}

	.star-panel-value {
		font-size: 13px;
		color: rgba(255, 255, 255, 0.75);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}

	.star-panel-link {
		display: inline-block;
		margin-top: 10px;
		font-size: 12px;
		letter-spacing: 0.5px;
		color: rgba(170, 200, 255, 0.7);
		text-decoration: none;
		transition: color 0.15s;
	}

	.star-panel-link:hover {
		color: rgba(170, 200, 255, 1);
	}

	.star-panel-constellations {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 2px;
		margin-top: 10px;
	}

	.star-panel-constellation-link {
		background: none;
		border: none;
		color: rgba(170, 200, 255, 0.7);
		font-family: inherit;
		font-size: 12px;
		letter-spacing: 0.5px;
		cursor: pointer;
		padding: 0;
		transition: color 0.15s;
	}

	.star-panel-constellation-link:hover {
		color: rgba(170, 200, 255, 1);
	}

	.star-panel-star-list {
		margin-top: 12px;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		padding-top: 10px;
	}

	.star-panel-list-title {
		font-size: 10px;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.3);
		margin-bottom: 6px;
	}

	.star-panel-star-btn {
		display: block;
		width: 100%;
		background: none;
		border: none;
		padding: 4px 0;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		color: rgba(170, 200, 255, 0.65);
		text-align: left;
		transition: color 0.15s;
	}

	.star-panel-star-btn:hover {
		color: rgba(170, 200, 255, 1);
	}

	.star-panel-star-mag {
		color: rgba(255, 255, 255, 0.3);
		font-size: 11px;
	}

	/* Mobile: collapse search and panel */
	@media (max-width: 480px) {
		.top-bar {
			top: 12px;
			left: 12px;
			right: 12px;
			gap: 6px;
		}

		.star-search-container {
			flex: 1;
			min-width: 0;
		}

		.star-search-input {
			font-size: 16px;
		}

		.star-panel {
			width: 200px;
			left: 12px;
			top: 48px;
		}
	}

	/* About modal */
	.about-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.about-modal {
		position: relative;
		background: rgba(6, 8, 16, 0.92);
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 4px;
		padding: 28px 30px 24px;
		max-width: 400px;
		width: calc(100% - 40px);
		color: rgba(255, 255, 255, 0.65);
		font-size: 13px;
		line-height: 1.65;
	}

	.about-close {
		position: absolute;
		top: 12px;
		right: 12px;
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.25);
		cursor: pointer;
		padding: 4px;
		display: flex;
	}

	.about-close:hover {
		color: rgba(255, 255, 255, 0.6);
	}

	.about-title {
		font-size: 14px;
		letter-spacing: 2px;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.55);
		margin: 0 0 16px;
		font-weight: 400;
	}

	.about-text {
		margin: 0 0 14px;
	}

	.about-section {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
	}

	.about-heading {
		font-size: 11px;
		letter-spacing: 1.5px;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.35);
		margin: 0 0 10px;
		font-weight: 400;
	}

	.about-list {
		margin: 0;
		padding-left: 16px;
		color: rgba(255, 255, 255, 0.55);
	}

	.about-list li {
		margin-bottom: 3px;
	}

	.about-list li::marker {
		color: rgba(255, 255, 255, 0.15);
	}

	.about-footer {
		margin-top: 18px;
		padding-top: 14px;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
		font-size: 12px;
		color: rgba(255, 255, 255, 0.4);
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.about-footer a {
		color: rgba(255, 255, 255, 0.55);
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}

	.about-footer a:hover {
		color: rgba(255, 255, 255, 0.7);
	}

	.about-divider {
		color: rgba(255, 255, 255, 0.1);
	}

	.about-footer-icon {
		width: 14px;
		height: 14px;
	}

	.about-footer-neal {
		gap: 5px;
	}

	@media (max-width: 480px) {
		.about-modal {
			padding: 22px 20px 18px;
		}
	}

	/* Safe area for notched phones */
	@supports (padding: env(safe-area-inset-bottom)) {
		.result-overlay {
			padding-bottom: env(safe-area-inset-bottom);
		}
	}

	/* Guided tour tooltip */
	.tour-tooltip {
		position: absolute;
		bottom: 140px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 25;
		background: rgba(0, 0, 0, 0.85);
		border: 1px solid rgba(255, 215, 0, 0.15);
		border-radius: 10px;
		padding: 12px 16px;
		max-width: 300px;
		animation: tour-fade-in 0.4s ease-out;
	}

	.tour-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 6px;
	}

	.tour-step {
		font-size: 10px;
		color: rgba(255, 215, 0, 0.5);
		letter-spacing: 1px;
		text-transform: uppercase;
	}

	.tour-dismiss {
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.3);
		cursor: pointer;
		padding: 2px;
		display: flex;
	}

	.tour-dismiss:hover {
		color: rgba(255, 255, 255, 0.6);
	}

	.tour-text {
		font-size: 13px;
		color: rgba(255, 255, 255, 0.8);
		line-height: 1.4;
		margin-bottom: 10px;
	}

	.tour-next {
		background: rgba(255, 215, 0, 0.1);
		border: 1px solid rgba(255, 215, 0, 0.2);
		color: rgba(255, 215, 0, 0.7);
		border-radius: 6px;
		padding: 4px 14px;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
	}

	.tour-next:hover {
		background: rgba(255, 215, 0, 0.18);
		color: rgba(255, 215, 0, 0.9);
	}

	@keyframes tour-fade-in {
		from { opacity: 0; transform: translateX(-50%) translateY(8px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	@media (max-width: 480px) {
		.tour-tooltip {
			bottom: 160px;
			max-width: 260px;
		}
	}
</style>
