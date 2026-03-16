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

	let inputText = $state('');
	let isMatching = $state(false);
	let isRerolling = $state(false);
	let showInput = $state(true);
	let starField: StarField;
	let constellations: ConstellationEntry[] = $state([]);
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
			name: text.toUpperCase(),
			starCount: result.pairs.length,
			catalogId: `WSC ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`,
			result,
		};
	}

	function showResult(text: string, result: MatchResult) {
		const entry = makeEntry(text, result);
		constellations = [...constellations, entry];

		showInput = false;
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
			// Show all constellations from the URL
			requestAnimationFrame(() => {
				for (const { text, result } of results) {
					showResult(text, result);
				}
			});
		}
	}

	// Initialize web worker for off-thread matching
	const worker = new MatchWorker();
	worker.postMessage({ type: 'init', payload: { stars } });

	let errorMessage = $state('');

	worker.onmessage = (e: MessageEvent) => {
		const { type, payload } = e.data;
		if (type === 'result') {
			if (isRerolling) {
				handleRerollResult(pendingText, payload as MatchResult);
			} else {
				showResult(pendingText, payload as MatchResult);
			}
		} else if (type === 'error') {
			isMatching = false;
			isRerolling = false;
			errorMessage = 'Something went wrong matching stars. Please try again.';
			setTimeout(() => (errorMessage = ''), 4000);
		}
	};

	worker.onerror = () => {
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
		pendingText = text;
		const usedStarIndices = getUsedStarIndices();
		worker.postMessage({ type: 'match', payload: { text, usedStarIndices } });
	}

	function handleRerollResult(text: string, result: MatchResult) {
		const entry = makeEntry(text, result);
		constellations = [...constellations.slice(0, -1), entry];
		isRerolling = false;
		isMatching = false;

		history.replaceState(null, '', '#' + encodeAllToHash(constellations));

		starField?.clearLastConstellation();
		starField?.animateToMatch(result);
	}

	function handleReroll() {
		if (constellations.length === 0) return;

		const lastEntry = constellations[constellations.length - 1];
		isRerolling = true;
		isMatching = true;
		pendingText = lastEntry.text;

		// Add the current result's stars to the accumulated re-roll blacklist
		for (const pair of lastEntry.result.pairs) {
			rerollBlacklist.push(pair.star.idx);
		}

		// Combine all active constellation stars + accumulated re-roll history
		const usedStarIndices = [...getUsedStarIndices(), ...rerollBlacklist];
		worker.postMessage({ type: 'match', payload: { text: lastEntry.text, usedStarIndices } });
	}

	function handleAddAnother() {
		showInput = true;
		inputText = '';
	}

	function handleReset() {
		constellations = [];
		rerollBlacklist = [];
		showInput = true;
		inputText = '';
		// Clear hash
		history.replaceState(null, '', window.location.pathname);
		starField?.resetView();
	}

	let copied = $state(false);
	let iauOverlay = $state(false);

	function handleToggleIAU() {
		iauOverlay = !iauOverlay;
		starField?.toggleIAUOverlay(iauOverlay);
	}

	async function handleShare() {
		try {
			await navigator.clipboard.writeText(window.location.href);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// Fallback: select a temporary input
			const tmp = document.createElement('input');
			tmp.value = window.location.href;
			document.body.appendChild(tmp);
			tmp.select();
			document.execCommand('copy');
			tmp.remove();
			copied = true;
			setTimeout(() => (copied = false), 2000);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			handleSubmit();
		}
	}

	function autoFocus(node: HTMLInputElement) {
		requestAnimationFrame(() => node.focus());
	}
</script>

<div class="app" role="application" aria-label="Written in the Stars - constellation creator">
	<StarField {stars} bind:this={starField} onReady={handleStarFieldReady} />

	<button
		class="iau-toggle"
		class:active={iauOverlay}
		onclick={handleToggleIAU}
		aria-label={iauOverlay ? 'Hide IAU constellations' : 'Show IAU constellations'}
		aria-pressed={iauOverlay}
	>
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<circle cx="5" cy="5" r="1.5" fill="currentColor" stroke="none"/>
			<circle cx="19" cy="4" r="1.5" fill="currentColor" stroke="none"/>
			<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
			<circle cx="4" cy="19" r="1.5" fill="currentColor" stroke="none"/>
			<circle cx="20" cy="18" r="1.5" fill="currentColor" stroke="none"/>
			<line x1="5" y1="5" x2="12" y2="12" />
			<line x1="19" y1="4" x2="12" y2="12" />
			<line x1="12" y1="12" x2="4" y2="19" />
			<line x1="12" y1="12" x2="20" y2="18" />
		</svg>
	</button>

	{#if showInput}
		<div class="input-overlay" class:matching={isMatching}>
			<label for="constellation-input" class="sr-only">Enter text to map to stars</label>
			<input
				id="constellation-input"
				type="text"
				bind:value={inputText}
				onkeydown={handleKeydown}
				placeholder="Type anything..."
				maxlength={30}
				disabled={isMatching}
				autocomplete="off"
				aria-describedby={isMatching ? 'matching-status' : undefined}
				use:autoFocus
			/>
			{#if isMatching}
				<div id="matching-status" class="matching-indicator" role="status" aria-live="polite">Finding stars...</div>
			{/if}
		</div>
	{/if}

	{#if errorMessage}
		<div class="error-toast" role="alert">{errorMessage}</div>
	{/if}

	{#if constellations.length > 0}
		<div class="result-overlay" class:dimmed={showInput} role="region" aria-label="Your constellations">
			{#each constellations as entry, i}
				<div class="constellation-entry" class:latest={i === constellations.length - 1 && !showInput}>
					<div class="constellation-name">{entry.name}</div>
					<div class="constellation-info">
						<span class="catalog-id">{entry.catalogId}</span>
						<span class="separator" aria-hidden="true">·</span>
						<span class="star-count">{entry.starCount} stars</span>
					</div>
				</div>
			{/each}
			{#if !showInput}
				<div class="result-actions" role="toolbar" aria-label="Constellation actions">
					<button class="reset-btn" onclick={handleReroll} disabled={isRerolling} aria-label="Re-roll constellation placement">
						{isRerolling ? 'Re-rolling...' : 'Re-roll'}
					</button>
					<button class="reset-btn" onclick={handleShare} aria-label={copied ? 'Link copied to clipboard' : 'Copy shareable link'}>
						{copied ? 'Copied!' : 'Share link'}
					</button>
					<button class="reset-btn" onclick={handleAddAnother} aria-label="Add another constellation">Add another</button>
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
		background: rgba(255, 255, 255, 0.05);
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
		color: rgba(255, 255, 255, 0.3);
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
		color: rgba(255, 215, 0, 0.6);
		font-size: 13px;
		letter-spacing: 3px;
		text-transform: uppercase;
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

	.constellation-entry {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		opacity: 0.4;
		transition: opacity 0.3s;
	}

	.constellation-entry.latest {
		opacity: 1;
	}

	.constellation-name {
		font-size: 28px;
		letter-spacing: 6px;
		color: #ffe680;
		text-shadow: 0 0 20px rgba(255, 215, 0, 0.3);
		text-transform: uppercase;
	}

	.constellation-entry:not(.latest) .constellation-name {
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

	.constellation-entry:not(.latest) .constellation-info {
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
		background: none;
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

	.iau-toggle {
		position: absolute;
		top: 16px;
		right: 16px;
		z-index: 10;
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

	.iau-toggle:hover {
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.7);
		border-color: rgba(255, 255, 255, 0.25);
	}

	.iau-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px rgba(170, 200, 255, 0.5);
	}

	.iau-toggle.active {
		background: rgba(170, 200, 255, 0.12);
		border-color: rgba(170, 200, 255, 0.3);
		color: rgba(170, 200, 255, 0.8);
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

		.constellation-entry:not(.latest) .constellation-name {
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

		.iau-toggle {
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
