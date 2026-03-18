<script>
	let { children } = $props();
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Marcellus&family=Space+Grotesk:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
	<style>
		:root {
			--font-ui: 'Space Grotesk', 'Segoe UI', system-ui, sans-serif;
			--font-display: 'Marcellus', 'Iowan Old Style', 'Palatino Linotype', serif;
		}

		html,
		body {
			margin: 0;
			padding: 0;
			width: 100%;
			height: 100%;
			overflow: hidden;
			background: #000;
			color: #ccc;
			font-family: var(--font-ui);
			font-synthesis: none;
			text-rendering: optimizeLegibility;
		}

		button,
		input,
		textarea,
		select {
			font: inherit;
		}
	</style>
	{@html `<script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'WebApplication',
		name: 'Written in the Stars',
		url: 'https://starspelled.com',
		description:
			'Some things are written in the stars. Type any word and watch real stars spell it across the night sky.',
		applicationCategory: 'Entertainment',
		operatingSystem: 'Any',
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
		browserRequirements: 'Requires WebGL',
	})}</script>`}
</svelte:head>

{@render children()}
