<script>
	let { children } = $props();
</script>

<svelte:head>
	<style>
		html, body {
			margin: 0;
			padding: 0;
			width: 100%;
			height: 100%;
			overflow: hidden;
			background: #000;
			color: #ccc;
			font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
		}
	</style>
	{@html `<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "WebApplication",
		"name": "Written in the Stars",
		"url": "https://starspelled.com",
		"description": "Some things are written in the stars. Type any word and watch real stars spell it across the night sky.",
		"applicationCategory": "Entertainment",
		"operatingSystem": "Any",
		"offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
		"browserRequirements": "Requires WebGL"
	})}</script>`}
</svelte:head>

{@render children()}
