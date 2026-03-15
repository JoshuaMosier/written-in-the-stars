<script lang="ts">
	import StarField from '$lib/scene/StarField.svelte';
	import { textToGraph } from '$lib/engine/glyphs';
	import { matchStarsToAnchors } from '$lib/engine/matcher';
	import starData from '$lib/data/stars.json';
	import type { Star, MatchResult } from '$lib/engine/types';

	const stars: Star[] = starData as Star[];

	let inputText = $state('');
	let matchResult: MatchResult | null = $state(null);
	let isMatching = $state(false);
	let showInput = $state(true);
	let starField: StarField;
	let constellationName = $state('');
	let starCount = $state(0);
	let catalogId = $state('');

	function handleSubmit() {
		const text = inputText.trim();
		if (!text) return;

		isMatching = true;

		// Run matching in a setTimeout to let the UI update
		setTimeout(() => {
			const graph = textToGraph(text);
			const result = matchStarsToAnchors(stars, graph);
			matchResult = result;
			constellationName = text.toUpperCase();
			starCount = result.pairs.length;

			// Generate a fake catalog ID
			const now = new Date();
			catalogId = `WSC ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

			showInput = false;
			isMatching = false;

			// Animate camera to the matched region
			starField?.animateToMatch(result);
		}, 50);
	}

	function handleReset() {
		matchResult = null;
		showInput = true;
		inputText = '';
		constellationName = '';
		starField?.resetView();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			handleSubmit();
		}
	}
</script>

<div class="app">
	<StarField {stars} {matchResult} bind:this={starField} />

	{#if showInput}
		<div class="input-overlay" class:matching={isMatching}>
			<input
				type="text"
				bind:value={inputText}
				onkeydown={handleKeydown}
				placeholder="Type anything..."
				maxlength={30}
				disabled={isMatching}
				autofocus
			/>
			{#if isMatching}
				<div class="matching-indicator">Finding stars...</div>
			{/if}
		</div>
	{/if}

	{#if !showInput && matchResult}
		<div class="result-overlay">
			<div class="constellation-name">{constellationName}</div>
			<div class="constellation-info">
				<span class="catalog-id">{catalogId}</span>
				<span class="separator">·</span>
				<span class="star-count">{starCount} stars</span>
			</div>
			<button class="reset-btn" onclick={handleReset}>Try another</button>
		</div>
	{/if}
</div>

<style>
	.app {
		position: relative;
		width: 100vw;
		height: 100vh;
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
		gap: 12px;
	}

	.input-overlay.matching {
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

	.matching-indicator {
		color: rgba(255, 215, 0, 0.6);
		font-size: 13px;
		letter-spacing: 3px;
		text-transform: uppercase;
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
	}

	.constellation-name {
		font-size: 28px;
		letter-spacing: 6px;
		color: #ffe680;
		text-shadow: 0 0 20px rgba(255, 215, 0, 0.3);
		text-transform: uppercase;
	}

	.constellation-info {
		font-size: 13px;
		color: rgba(255, 255, 255, 0.4);
		letter-spacing: 2px;
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.separator {
		opacity: 0.5;
	}

	.reset-btn {
		margin-top: 12px;
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

	.reset-btn:hover {
		border-color: rgba(255, 215, 0, 0.3);
		color: rgba(255, 215, 0, 0.7);
	}
</style>
