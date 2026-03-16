<script lang="ts">
	import StarField from '$lib/scene/StarField.svelte';
	import { textToGraph } from '$lib/engine/glyphs';
	import starData from '$lib/data/stars.json';
	import type { Star, MatchResult } from '$lib/engine/types';
	import MatchWorker from '$lib/engine/match.worker?worker';

	const stars: Star[] = (starData as Star[]).filter(s => s.mag > -10);
	const starByIdx = new Map<number, Star>();
	for (const s of stars) starByIdx.set(s.idx, s);

	interface ConstellationEntry {
		text: string;
		name: string;
		starCount: number;
		catalogId: string;
		result: MatchResult;
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
	let isMatching = $state(false);
	let isRerolling = $state(false);
	let matchProgress = $state(0);
	let showInput = $state(true);
	let starField: StarField;
	let constellations: ConstellationEntry[] = $state([]);
	let focusedIndex = $state(-1);
	let rerollBlacklist: number[] = [];  // accumulates stars from previous re-rolls

	// --- URL hash encoding/decoding ---
	// Compact format: text~<base64url of 14-bit packed star indices>
	// Each star.idx is packed as 14 bits (max 16383, we have ~8870 stars)
	// Node indices are implicit (array position = nodeIndex)
	const BITS_PER_IDX = 14;

	function encodeSingleResult(text: string, result: MatchResult): string {
		const sorted = [...result.pairs].sort((a, b) => a.nodeIndex - b.nodeIndex);
		const totalBits = sorted.length * BITS_PER_IDX;
		const buf = new Uint8Array(Math.ceil(totalBits / 8));
		let bitPos = 0;
		for (let i = 0; i < sorted.length; i++) {
			const idx = sorted[i].star.idx;
			for (let b = BITS_PER_IDX - 1; b >= 0; b--) {
				const bit = (idx >> b) & 1;
				const byteIdx = Math.floor(bitPos / 8);
				const bitIdx = 7 - (bitPos % 8);
				buf[byteIdx] |= bit << bitIdx;
				bitPos++;
			}
		}
		let b64 = '';
		for (let i = 0; i < buf.length; i++) b64 += String.fromCharCode(buf[i]);
		b64 = btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const textB64 = btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		return textB64 + '~' + b64;
	}

	function decodeSingleResult(segment: string): { text: string; result: MatchResult } | null {
		try {
			const sepIdx = segment.indexOf('~');
			if (sepIdx < 0) return null;

			let textB64 = segment.slice(0, sepIdx).replace(/-/g, '+').replace(/_/g, '/');
			while (textB64.length % 4) textB64 += '=';
			const text = decodeURIComponent(escape(atob(textB64)));
			const graph = textToGraph(text);

			let b64 = segment.slice(sepIdx + 1).replace(/-/g, '+').replace(/_/g, '/');
			while (b64.length % 4) b64 += '=';
			const raw = atob(b64);
			const buf = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

			const count = graph.nodes.length;
			const totalBits = count * BITS_PER_IDX;
			if (buf.length < Math.ceil(totalBits / 8)) return null;

			const pairs: MatchResult['pairs'] = [];
			let bitPos = 0;
			for (let i = 0; i < count; i++) {
				let idx = 0;
				for (let b = BITS_PER_IDX - 1; b >= 0; b--) {
					const byteIdx = Math.floor(bitPos / 8);
					const bitIdx = 7 - (bitPos % 8);
					idx |= ((buf[byteIdx] >> bitIdx) & 1) << b;
					bitPos++;
				}
				const star = starByIdx.get(idx);
				if (!star) return null;
				pairs.push({ star, nodeIndex: i });
			}
			return {
				text,
				result: { pairs, cost: 0, transform: { x: 0, y: 0, scale: 0 }, graph },
			};
		} catch {
			return null;
		}
	}

	// Multiple constellations separated by '|' in the hash
	function encodeAllToHash(entries: ConstellationEntry[]): string {
		return entries.map(e => encodeSingleResult(e.text, e.result)).join('|');
	}

	function decodeHashToResults(hash: string): { text: string; result: MatchResult }[] {
		const segments = hash.split('|');
		const results: { text: string; result: MatchResult }[] = [];
		for (const seg of segments) {
			const decoded = decodeSingleResult(seg);
			if (decoded) results.push(decoded);
		}
		return results;
	}

	function makeEntry(text: string, result: MatchResult): ConstellationEntry {
		const now = new Date();
		return {
			text,
			name: text,
			starCount: result.pairs.length,
			catalogId: `WSC ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`,
			result,
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

		starField?.animateToMatch(result);
	}

	// --- Check URL hash on load ---
	let pendingHashResults: { text: string; result: MatchResult }[] = [];

	if (typeof window !== 'undefined' && window.location.hash.length > 1) {
		pendingHashResults = decodeHashToResults(window.location.hash.slice(1));
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
				starField?.refocusConstellation(allResults, focusedIndex);
			});
		}
	}

	// Initialize web worker for off-thread matching
	const worker = new MatchWorker();
	worker.postMessage({ type: 'init', payload: { stars } });

	let errorMessage = $state('');

	worker.onmessage = (e: MessageEvent) => {
		const { type, payload } = e.data;
		if (type === 'progress') {
			matchProgress = payload as number;
		} else if (type === 'result') {
			matchProgress = 1;
			if (isRerolling) {
				handleRerollResult(pendingText, payload as MatchResult);
			} else {
				showResult(pendingText, payload as MatchResult);
			}
		} else if (type === 'error') {
			if (isRerolling) showInput = false;
			isMatching = false;
			isRerolling = false;
			errorMessage = 'Something went wrong matching stars. Please try again.';
			setTimeout(() => (errorMessage = ''), 4000);
		}
	};

	worker.onerror = () => {
		stopMatchingPhrases();
		if (isRerolling) showInput = false;
		isMatching = false;
		isRerolling = false;
		errorMessage = 'Something went wrong. Please try again.';
		setTimeout(() => (errorMessage = ''), 4000);
	};

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
		if (!text) return;

		rerollBlacklist = [];
		isMatching = true;
		matchProgress = 0;
		startMatchingPhrases();
		pendingText = text;
		const usedStarIndices = getUsedStarIndices();
		worker.postMessage({ type: 'match', payload: { text, usedStarIndices } });
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
		starField?.refocusConstellation(allResults, focusedIndex);
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
		worker.postMessage({ type: 'match', payload: { text: targetEntry.text, usedStarIndices } });
	}

	function handleFocusConstellation(index: number) {
		if (showInput || isMatching) return;
		if (index === focusedIndex) return;
		focusedIndex = index;
		const allResults = constellations.map(c => c.result);
		starField?.panToConstellation(allResults, index);
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
		starField?.refocusConstellation(allResults, focusedIndex);
	}

	function handleAddAnother() {
		showInput = true;
		inputText = '';
	}

	function handleReset() {
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
		autoRotate = true;
		starField?.toggleAutoRotate(true);
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
		starField?.redrawConstellations(constellations.map(c => c.result));
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
	let iauOverlay = $state(false);
	let autoRotate = $state(true);
	let starLabels = $state(false);
	let coordGrid = $state(false);
	let shootingStars = $state(true);
	let brightness = $state(1.0);
	let monoColor = $state(false);
	let settingsOpen = $state(false);

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

	async function handleShare() {
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

	// Global undo/redo listener
	if (typeof window !== 'undefined') {
		window.addEventListener('keydown', (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
				e.preventDefault();
				handleUndo();
			}
			if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
				e.preventDefault();
				handleRedo();
			}
		});
	}

	function handleClickOutsideSettings(e: MouseEvent) {
		if (!settingsOpen) return;
		const target = e.target as HTMLElement;
		if (!target.closest('.settings-container')) {
			settingsOpen = false;
		}
	}

	function autoFocus(node: HTMLInputElement) {
		requestAnimationFrame(() => node.focus());
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div class="app" role="application" aria-label="Written in the Stars - constellation creator" onclick={handleClickOutsideSettings}>
	<StarField {stars} bind:this={starField} onReady={handleStarFieldReady} onVertexDrag={handleVertexDrag} />

	<div class="settings-container">
		<button
			class="settings-hamburger"
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

	{#if showInput}
		<div class="input-overlay" class:matching={isMatching}>
			<label for="constellation-input" class="sr-only">Enter text to map to stars</label>
			<input
				id="constellation-input"
				type="text"
				bind:value={inputText}
				onkeydown={handleKeydown}

				placeholder="Search the stars..."
				maxlength={30}
				disabled={isMatching}
				autocomplete="off"
				aria-describedby={isMatching ? 'matching-status' : undefined}
				use:autoFocus
			/>
			{#if isMatching}
				<div id="matching-status" class="matching-indicator" role="status" aria-live="polite">
					<span class="matching-phrase">{matchingPhrase}...</span>
					<span class="matching-pct">{Math.round(matchProgress * 100)}%</span>
				</div>
			{/if}
		</div>
	{/if}

	{#if errorMessage}
		<div class="error-toast" role="alert">{errorMessage}</div>
	{/if}

	<a class="attribution" href="https://neal.fun/constellation-draw/" target="_blank" rel="noopener noreferrer">
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

	<a class="author" href="https://x.com/joshrmosier" target="_blank" rel="noopener noreferrer">Made by Josh Mosier</a>

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
					<div class="constellation-name">{entry.name}</div>
					<div class="constellation-info">
						<span class="catalog-id">{entry.catalogId}</span>
						<span class="separator" aria-hidden="true">·</span>
						<span class="star-count">{entry.starCount} stars</span>
					</div>
				</button>
				{#if !showInput && !isMatching}
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
					<button class="reset-btn" onclick={handleReroll} disabled={isRerolling} aria-label="Re-roll constellation placement">
						{isRerolling ? 'Re-rolling...' : 'Re-roll'}
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
	}

	.input-overlay.matching input {
		opacity: 0.6;
		pointer-events: none;
	}

	input {
		background: rgba(0, 0, 0, 0.2);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		color: #fff;
		font-size: 24px;
		font-family: inherit;
		padding: 16px 28px;
		width: 420px;
		max-width: 85vw;
		text-align: center;
		letter-spacing: 2px;
		outline: none;
		backdrop-filter: blur(8px);
		transition: border-color 0.2s;
	}

	input::placeholder {
		color: rgba(255, 255, 255, 0.5);
	}

	input:focus {
		border-color: rgba(255, 215, 0, 0.4);
	}

	input:focus-visible {
		box-shadow: 0 0 0 2px rgba(255, 215, 0, 0.3);
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

	.error-toast {
		position: absolute;
		top: 24px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		background: rgba(200, 50, 50, 0.15);
		border: 1px solid rgba(200, 50, 50, 0.3);
		color: rgba(255, 150, 150, 0.9);
		padding: 10px 24px;
		border-radius: 8px;
		font-size: 14px;
		letter-spacing: 0.5px;
		backdrop-filter: blur(8px);
		animation: toast-in 0.3s ease-out;
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
		opacity: 0.3;
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
		width: 26px;
		flex-shrink: 0;
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
		color: rgba(255, 215, 0, 0.85);
		text-shadow: 0 0 20px rgba(255, 215, 0, 0.3);
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
		background: rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(8px);
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

	.attribution {
		position: absolute;
		bottom: 14px;
		left: 16px;
		z-index: 10;
		color: rgba(255, 255, 255, 0.4);
		font-size: 12px;
		letter-spacing: 0.5px;
		text-decoration: none;
		transition: color 0.2s;
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.attribution:hover {
		color: rgba(255, 255, 255, 0.7);
	}

	.author {
		position: absolute;
		bottom: 14px;
		right: 16px;
		z-index: 10;
		color: rgba(255, 255, 255, 0.4);
		font-size: 12px;
		letter-spacing: 0.5px;
		text-decoration: none;
		transition: color 0.2s;
	}

	.author:hover {
		color: rgba(255, 255, 255, 0.7);
	}

	.neal-logo {
		height: 14px;
		width: auto;
	}

	.settings-container {
		position: absolute;
		top: 16px;
		right: 16px;
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
	}

	.settings-hamburger {
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
		backdrop-filter: blur(4px);
	}

	.settings-hamburger:hover {
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.7);
		border-color: rgba(255, 255, 255, 0.25);
	}

	.settings-hamburger.open {
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.7);
		border-color: rgba(255, 255, 255, 0.25);
	}

	.settings-hamburger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px rgba(170, 200, 255, 0.5);
	}

	.settings-panel {
		background: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 10px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		animation: panel-in 0.15s ease-out;
	}

	@keyframes panel-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
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
		input {
			font-size: 18px;
			padding: 14px 20px;
			letter-spacing: 1.5px;
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

		.settings-container {
			top: env(safe-area-inset-top, 16px);
			right: env(safe-area-inset-right, 16px);
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

	/* Safe area for notched phones */
	@supports (padding: env(safe-area-inset-bottom)) {
		.result-overlay {
			padding-bottom: env(safe-area-inset-bottom);
		}
	}
</style>
