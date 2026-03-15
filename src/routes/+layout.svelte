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
</svelte:head>

{@render children()}
