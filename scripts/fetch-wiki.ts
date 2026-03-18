import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STARS_PATH = join(__dirname, '..', 'static', 'stars.json');
const STAR_OUTPUT = join(__dirname, '..', 'static', 'star-wiki.json');
const CONSTELLATION_OUTPUT = join(__dirname, '..', 'static', 'constellation-wiki.json');

// Rate-limit: Wikipedia returns 429 if we go too fast
const DELAY_MS = 250;

interface StarEntry {
	idx: number;
	id: number;
	hip?: number;
	name?: string;
	[key: string]: unknown;
}

interface WikiResult {
	url: string;
	description: string; // short extract suitable for embed / tooltip
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Try fetching a Wikipedia summary for a given title. Returns null on miss. Retries on 429. */
async function fetchWikiSummary(title: string, retries = 3): Promise<{ url: string; extract: string } | null> {
	const encoded = encodeURIComponent(title.replace(/ /g, '_'));
	const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const res = await fetch(apiUrl, {
			headers: { 'User-Agent': 'StarspelledBot/1.0 (starspelled.com)' },
			redirect: 'follow',
		});

		if (res.status === 429) {
			const wait = (attempt + 1) * 2000;
			process.stdout.write(`[429, waiting ${wait / 1000}s] `);
			await sleep(wait);
			continue;
		}

		if (!res.ok) return null;

		const data = (await res.json()) as {
			type: string;
			title: string;
			content_urls?: { desktop?: { page?: string } };
			extract?: string;
			description?: string;
		};

		// Skip disambiguation pages
		if (data.type === 'disambiguation') return null;

		const url = data.content_urls?.desktop?.page;
		const extract = data.extract || data.description || '';

		if (!url) return null;
		return { url, extract };
	}

	return null; // all retries exhausted
}

/** Check whether a Wikipedia extract is actually about a star (not a person, place, etc.) */
function looksLikeStar(extract: string): boolean {
	const lower = extract.toLowerCase();
	const starTerms = [
		'star',
		'stellar',
		'constellation',
		'magnitude',
		'light-year',
		'light year',
		'luminosity',
		'binary',
		'supergiant',
		'giant star',
		'dwarf',
		'spectral',
		'parsec',
		'celestial',
		'brightest',
		'variable star',
		'ecliptic',
		'solar system', // for Sol
	];
	return starTerms.some((t) => lower.includes(t));
}

function trimExtract(text: string, max = 200): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 3).replace(/\s+\S*$/, '') + '...';
}

/**
 * Constellation name → Wikipedia URL, extracted from the IAU designated constellations
 * Wikipedia page. These are the canonical URLs — some use bare names, some use
 * "_(constellation)" disambiguation.
 */
const CONSTELLATION_URLS: Record<string, string> = {
	Andromeda: 'https://en.wikipedia.org/wiki/Andromeda_(constellation)',
	Antlia: 'https://en.wikipedia.org/wiki/Antlia',
	Apus: 'https://en.wikipedia.org/wiki/Apus',
	Aquarius: 'https://en.wikipedia.org/wiki/Aquarius_(constellation)',
	Aquila: 'https://en.wikipedia.org/wiki/Aquila_(constellation)',
	Ara: 'https://en.wikipedia.org/wiki/Ara_(constellation)',
	Aries: 'https://en.wikipedia.org/wiki/Aries_(constellation)',
	Auriga: 'https://en.wikipedia.org/wiki/Auriga_(constellation)',
	Boötes: 'https://en.wikipedia.org/wiki/Bo%C3%B6tes',
	Caelum: 'https://en.wikipedia.org/wiki/Caelum',
	Camelopardalis: 'https://en.wikipedia.org/wiki/Camelopardalis',
	Cancer: 'https://en.wikipedia.org/wiki/Cancer_(constellation)',
	'Canes Venatici': 'https://en.wikipedia.org/wiki/Canes_Venatici',
	'Canis Major': 'https://en.wikipedia.org/wiki/Canis_Major',
	'Canis Minor': 'https://en.wikipedia.org/wiki/Canis_Minor',
	Capricornus: 'https://en.wikipedia.org/wiki/Capricornus',
	Carina: 'https://en.wikipedia.org/wiki/Carina_(constellation)',
	Cassiopeia: 'https://en.wikipedia.org/wiki/Cassiopeia_(constellation)',
	Centaurus: 'https://en.wikipedia.org/wiki/Centaurus',
	Cepheus: 'https://en.wikipedia.org/wiki/Cepheus_(constellation)',
	Cetus: 'https://en.wikipedia.org/wiki/Cetus_(constellation)',
	Chamaeleon: 'https://en.wikipedia.org/wiki/Chamaeleon',
	Circinus: 'https://en.wikipedia.org/wiki/Circinus',
	Columba: 'https://en.wikipedia.org/wiki/Columba_(constellation)',
	'Coma Berenices': 'https://en.wikipedia.org/wiki/Coma_Berenices',
	'Corona Australis': 'https://en.wikipedia.org/wiki/Corona_Australis',
	'Corona Borealis': 'https://en.wikipedia.org/wiki/Corona_Borealis',
	Corvus: 'https://en.wikipedia.org/wiki/Corvus_(constellation)',
	Crater: 'https://en.wikipedia.org/wiki/Crater_(constellation)',
	Crux: 'https://en.wikipedia.org/wiki/Crux',
	Cygnus: 'https://en.wikipedia.org/wiki/Cygnus_(constellation)',
	Delphinus: 'https://en.wikipedia.org/wiki/Delphinus',
	Dorado: 'https://en.wikipedia.org/wiki/Dorado',
	Draco: 'https://en.wikipedia.org/wiki/Draco_(constellation)',
	Equuleus: 'https://en.wikipedia.org/wiki/Equuleus',
	Eridanus: 'https://en.wikipedia.org/wiki/Eridanus_(constellation)',
	Fornax: 'https://en.wikipedia.org/wiki/Fornax',
	Gemini: 'https://en.wikipedia.org/wiki/Gemini_(constellation)',
	Grus: 'https://en.wikipedia.org/wiki/Grus_(constellation)',
	Hercules: 'https://en.wikipedia.org/wiki/Hercules_(constellation)',
	Horologium: 'https://en.wikipedia.org/wiki/Horologium_(constellation)',
	Hydra: 'https://en.wikipedia.org/wiki/Hydra_(constellation)',
	Hydrus: 'https://en.wikipedia.org/wiki/Hydrus',
	Indus: 'https://en.wikipedia.org/wiki/Indus_(constellation)',
	Lacerta: 'https://en.wikipedia.org/wiki/Lacerta',
	Leo: 'https://en.wikipedia.org/wiki/Leo_(constellation)',
	'Leo Minor': 'https://en.wikipedia.org/wiki/Leo_Minor',
	Lepus: 'https://en.wikipedia.org/wiki/Lepus_(constellation)',
	Libra: 'https://en.wikipedia.org/wiki/Libra_(constellation)',
	Lupus: 'https://en.wikipedia.org/wiki/Lupus_(constellation)',
	Lynx: 'https://en.wikipedia.org/wiki/Lynx_(constellation)',
	Lyra: 'https://en.wikipedia.org/wiki/Lyra',
	Mensa: 'https://en.wikipedia.org/wiki/Mensa_(constellation)',
	Microscopium: 'https://en.wikipedia.org/wiki/Microscopium',
	Monoceros: 'https://en.wikipedia.org/wiki/Monoceros',
	Musca: 'https://en.wikipedia.org/wiki/Musca',
	Norma: 'https://en.wikipedia.org/wiki/Norma_(constellation)',
	Octans: 'https://en.wikipedia.org/wiki/Octans',
	Ophiuchus: 'https://en.wikipedia.org/wiki/Ophiuchus',
	Orion: 'https://en.wikipedia.org/wiki/Orion_(constellation)',
	Pavo: 'https://en.wikipedia.org/wiki/Pavo_(constellation)',
	Pegasus: 'https://en.wikipedia.org/wiki/Pegasus_(constellation)',
	Perseus: 'https://en.wikipedia.org/wiki/Perseus_(constellation)',
	Phoenix: 'https://en.wikipedia.org/wiki/Phoenix_(constellation)',
	Pictor: 'https://en.wikipedia.org/wiki/Pictor',
	Pisces: 'https://en.wikipedia.org/wiki/Pisces_(constellation)',
	'Piscis Austrinus': 'https://en.wikipedia.org/wiki/Piscis_Austrinus',
	Puppis: 'https://en.wikipedia.org/wiki/Puppis',
	Pyxis: 'https://en.wikipedia.org/wiki/Pyxis',
	Reticulum: 'https://en.wikipedia.org/wiki/Reticulum',
	Sagitta: 'https://en.wikipedia.org/wiki/Sagitta',
	Sagittarius: 'https://en.wikipedia.org/wiki/Sagittarius_(constellation)',
	Scorpius: 'https://en.wikipedia.org/wiki/Scorpius',
	Sculptor: 'https://en.wikipedia.org/wiki/Sculptor_(constellation)',
	Scutum: 'https://en.wikipedia.org/wiki/Scutum_(constellation)',
	Serpens: 'https://en.wikipedia.org/wiki/Serpens',
	Sextans: 'https://en.wikipedia.org/wiki/Sextans',
	Taurus: 'https://en.wikipedia.org/wiki/Taurus_(constellation)',
	Telescopium: 'https://en.wikipedia.org/wiki/Telescopium',
	Triangulum: 'https://en.wikipedia.org/wiki/Triangulum',
	'Triangulum Australe': 'https://en.wikipedia.org/wiki/Triangulum_Australe',
	Tucana: 'https://en.wikipedia.org/wiki/Tucana',
	'Ursa Major': 'https://en.wikipedia.org/wiki/Ursa_Major',
	'Ursa Minor': 'https://en.wikipedia.org/wiki/Ursa_Minor',
	Vela: 'https://en.wikipedia.org/wiki/Vela_(constellation)',
	Virgo: 'https://en.wikipedia.org/wiki/Virgo_(constellation)',
	Volans: 'https://en.wikipedia.org/wiki/Volans',
	Vulpecula: 'https://en.wikipedia.org/wiki/Vulpecula',
};

async function main() {
	// --- Load existing results to skip already-resolved entries ---
	const existingStars: Record<string, WikiResult> = existsSync(STAR_OUTPUT)
		? JSON.parse(readFileSync(STAR_OUTPUT, 'utf-8'))
		: {};
	const existingConstellations: Record<string, WikiResult> = existsSync(CONSTELLATION_OUTPUT)
		? JSON.parse(readFileSync(CONSTELLATION_OUTPUT, 'utf-8'))
		: {};

	// --- Stars ---
	const stars: StarEntry[] = JSON.parse(readFileSync(STARS_PATH, 'utf-8'));
	const named = stars.filter((s) => s.name);
	const newStars = named.filter((s) => !existingStars[s.name!]);

	console.log(
		`Stars: ${named.length} named, ${Object.keys(existingStars).length} cached, ${newStars.length} to fetch\n`,
	);

	const starResults: Record<string, WikiResult> = { ...existingStars };
	const starFailed: string[] = [];

	for (const star of newStars) {
		const name = star.name!;
		process.stdout.write(`  ${name} ... `);

		// Strategy: try "Name_(star)" first (most precise), then bare "Name"
		let hit = await fetchWikiSummary(`${name} (star)`);

		if (!hit) {
			await sleep(DELAY_MS);
			hit = await fetchWikiSummary(name);
		}

		// If we got a hit on the bare name, verify it's actually about a star
		if (hit && !hit.url.includes('_(star)')) {
			if (!looksLikeStar(hit.extract)) {
				console.log(`SKIP (not a star article: "${hit.extract.slice(0, 60)}...")`);
				starFailed.push(name);
				await sleep(DELAY_MS);
				continue;
			}
		}

		if (hit) {
			starResults[name] = { url: hit.url, description: trimExtract(hit.extract) };
			console.log('OK');
		} else {
			console.log('MISS');
			starFailed.push(name);
		}

		await sleep(DELAY_MS);
	}

	// --- Constellations ---
	const constellationNames = Object.keys(CONSTELLATION_URLS);
	const newConstellations = constellationNames.filter((n) => !existingConstellations[n]);

	console.log(
		`\nConstellations: ${constellationNames.length} total, ${Object.keys(existingConstellations).length} cached, ${newConstellations.length} to fetch\n`,
	);

	const constellationResults: Record<string, WikiResult> = {
		...existingConstellations,
	};
	const constellationFailed: string[] = [];

	for (const name of newConstellations) {
		process.stdout.write(`  ${name} ... `);

		// Use the known URL to derive the Wikipedia API title
		const knownUrl = CONSTELLATION_URLS[name];
		const wikiTitle = decodeURIComponent(knownUrl.split('/wiki/')[1]);
		const hit = await fetchWikiSummary(wikiTitle);

		if (hit) {
			constellationResults[name] = {
				url: knownUrl,
				description: trimExtract(hit.extract),
			};
			console.log('OK');
		} else {
			console.log('MISS');
			constellationFailed.push(name);
		}

		await sleep(DELAY_MS);
	}

	// --- Summary ---
	console.log(`\n--- Stars ---`);
	console.log(`Resolved: ${Object.keys(starResults).length}`);
	console.log(`Failed:   ${starFailed.length}`);
	if (starFailed.length > 0) {
		console.log(`Unresolved:`);
		for (const name of starFailed) {
			const star = named.find((s) => s.name === name)!;
			console.log(`  - ${name} (HIP ${star.hip || '?'})`);
		}
	}

	console.log(`\n--- Constellations ---`);
	console.log(`Resolved: ${Object.keys(constellationResults).length}`);
	console.log(`Failed:   ${constellationFailed.length}`);
	if (constellationFailed.length > 0) {
		console.log(`Unresolved:`);
		for (const name of constellationFailed) {
			console.log(`  - ${name}`);
		}
	}

	writeFileSync(STAR_OUTPUT, JSON.stringify(starResults, null, 2));
	console.log(`\nWrote ${STAR_OUTPUT}`);

	writeFileSync(CONSTELLATION_OUTPUT, JSON.stringify(constellationResults, null, 2));
	console.log(`Wrote ${CONSTELLATION_OUTPUT}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
