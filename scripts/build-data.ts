/**
 * One-time build script: merge stars.csv and constellations_hip.csv into
 *   - src/lib/data/stars.json  (stars with HIP IDs)
 *   - src/lib/data/constellations.ts  (constellation line data using HIP IDs)
 *
 * Run with: npx tsx scripts/build-data.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "src", "lib", "data");

// --- IAU constellation abbreviation → full name ---
const IAU_NAMES: Record<string, string> = {
  And: "Andromeda", Ant: "Antlia", Aps: "Apus", Aql: "Aquila", Aqr: "Aquarius",
  Ara: "Ara", Ari: "Aries", Aur: "Auriga", Boo: "Boötes", CMa: "Canis Major",
  CMi: "Canis Minor", CVn: "Canes Venatici", Cae: "Caelum", Cam: "Camelopardalis",
  Cap: "Capricornus", Car: "Carina", Cas: "Cassiopeia", Cen: "Centaurus",
  Cep: "Cepheus", Cet: "Cetus", Cha: "Chamaeleon", Cir: "Circinus",
  Cnc: "Cancer", Col: "Columba", Com: "Coma Berenices", CrA: "Corona Australis",
  CrB: "Corona Borealis", Crt: "Crater", Cru: "Crux", Crv: "Corvus",
  Cyg: "Cygnus", Del: "Delphinus", Dor: "Dorado", Dra: "Draco",
  Equ: "Equuleus", Eri: "Eridanus", For: "Fornax", Gem: "Gemini",
  Gru: "Grus", Her: "Hercules", Hor: "Horologium", Hya: "Hydra",
  Hyi: "Hydrus", Ind: "Indus", LMi: "Leo Minor", Lac: "Lacerta",
  Leo: "Leo", Lep: "Lepus", Lib: "Libra", Lup: "Lupus", Lyn: "Lynx",
  Lyr: "Lyra", Men: "Mensa", Mic: "Microscopium", Mon: "Monoceros",
  Mus: "Musca", Nor: "Norma", Oct: "Octans", Oph: "Ophiuchus",
  Ori: "Orion", Pav: "Pavo", Peg: "Pegasus", Per: "Perseus", Phe: "Phoenix",
  Pic: "Pictor", PsA: "Piscis Austrinus", Psc: "Pisces", Pup: "Puppis",
  Pyx: "Pyxis", Ret: "Reticulum", Scl: "Sculptor", Sco: "Scorpius",
  Sct: "Scutum", Ser: "Serpens", Sex: "Sextans", Sge: "Sagitta",
  Sgr: "Sagittarius", Tau: "Taurus", Tel: "Telescopium", TrA: "Triangulum Australe",
  Tri: "Triangulum", Tuc: "Tucana", UMa: "Ursa Major", UMi: "Ursa Minor",
  Vel: "Vela", Vir: "Virgo", Vol: "Volans", Vul: "Vulpecula",
};

// --- Parse stars.csv ---
interface Star {
  id: number;
  hip?: number;
  ra: number;
  dec: number;
  mag: number;
  ci?: number;
  name?: string;
}

function buildStars(): Star[] {
  const csv = readFileSync(join(ROOT, "stars.csv"), "utf-8");
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",");

  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Column "${name}" not found in stars.csv`);
    return i;
  };

  const raIdx = idx("ra");   // RA is in hours (0-24)
  const decIdx = idx("dec"); // Dec is in degrees (-90 to +90)
  const magIdx = idx("mag");
  const ciIdx = idx("ci");
  const properIdx = idx("proper");
  const hipIdx = idx("hip");

  const stars: Star[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");

    const raHours = parseFloat(cols[raIdx]);
    const decDeg = parseFloat(cols[decIdx]);
    const mag = parseFloat(cols[magIdx]);

    if (isNaN(raHours) || isNaN(decDeg) || isNaN(mag)) continue;
    if (mag > 6.5) continue;

    const hipStr = cols[hipIdx]?.trim();
    const hip = hipStr ? parseInt(hipStr, 10) : NaN;

    // Use HIP as primary ID
    const id = !isNaN(hip) && hip > 0 ? hip : i;

    const star: Star = {
      id,
      ra: Math.round((raHours * Math.PI) / 12 * 1e6) / 1e6,  // hours → radians
      dec: Math.round((decDeg * Math.PI) / 180 * 1e6) / 1e6,
      mag: Math.round(mag * 100) / 100,
    };

    if (!isNaN(hip) && hip > 0) {
      star.hip = hip;
    }

    const ciStr = cols[ciIdx]?.trim();
    if (ciStr) {
      const ci = parseFloat(ciStr);
      if (!isNaN(ci)) star.ci = Math.round(ci * 100) / 100;
    }

    const proper = cols[properIdx]?.trim();
    if (proper) star.name = proper;

    stars.push(star);
  }

  // Sort brightest first
  stars.sort((a, b) => a.mag - b.mag);

  return stars;
}

// --- Parse constellations_hip.csv ---
interface ConstellationDef {
  name: string;
  lines: [number, number][]; // HIP ID pairs
}

function buildConstellations(hipSet: Set<number>): ConstellationDef[] {
  const csv = readFileSync(join(ROOT, "constellations_hip.csv"), "utf-8");
  const lines = csv.trim().split("\n");

  const grouped = new Map<string, [number, number][]>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const abbr = cols[0].trim();
    const hip1 = parseInt(cols[1].trim(), 10);
    const hip2 = parseInt(cols[2].trim(), 10);

    if (isNaN(hip1) || isNaN(hip2)) continue;

    if (!grouped.has(abbr)) grouped.set(abbr, []);
    grouped.get(abbr)!.push([hip1, hip2]);
  }

  const constellations: ConstellationDef[] = [];

  for (const [abbr, edges] of grouped) {
    const name = IAU_NAMES[abbr] || abbr;

    // Only include edges where both stars exist in our dataset
    const validEdges = edges.filter(([h1, h2]) => hipSet.has(h1) && hipSet.has(h2));
    if (validEdges.length === 0) continue;

    constellations.push({ name, lines: validEdges });
  }

  // Sort by name for stability
  constellations.sort((a, b) => a.name.localeCompare(b.name));

  return constellations;
}

// --- Main ---
mkdirSync(OUT_DIR, { recursive: true });

console.log("Building stars from stars.csv...");
const stars = buildStars();
console.log(`  ${stars.length} stars (mag ≤ 6.5)`);
console.log(`  ${stars.filter(s => s.name).length} named`);
console.log(`  ${stars.filter(s => s.hip).length} with HIP IDs`);

// Write stars.json
const starsJson = JSON.stringify(stars);
writeFileSync(join(OUT_DIR, "stars.json"), starsJson);
console.log(`  Wrote stars.json (${(Buffer.byteLength(starsJson) / 1e6).toFixed(2)} MB)`);

// Build HIP lookup set
const hipSet = new Set(stars.filter(s => s.hip).map(s => s.hip!));

console.log("\nBuilding constellations from constellations_hip.csv...");
const constellations = buildConstellations(hipSet);
console.log(`  ${constellations.length} constellations`);
console.log(`  ${constellations.reduce((n, c) => n + c.lines.length, 0)} line segments`);

// Write constellations.ts
const tsContent = `/**
 * IAU constellation stick-figure definitions.
 * Auto-generated from constellations_hip.csv by scripts/build-data.ts
 * Each line segment connects two stars by their HIP (Hipparcos) catalog number.
 */

export interface ConstellationDef {
  name: string;
  lines: [number, number][];
}

export const CONSTELLATIONS: ConstellationDef[] = ${JSON.stringify(constellations, null, 2)};
`;

writeFileSync(join(OUT_DIR, "constellations.ts"), tsContent);
console.log(`  Wrote constellations.ts`);

// Report any missing stars
const allHips = new Set<number>();
const csvLines = readFileSync(join(ROOT, "constellations_hip.csv"), "utf-8").trim().split("\n");
for (let i = 1; i < csvLines.length; i++) {
  const cols = csvLines[i].split(",");
  allHips.add(parseInt(cols[1].trim(), 10));
  allHips.add(parseInt(cols[2].trim(), 10));
}
const missing = [...allHips].filter(h => !hipSet.has(h));
if (missing.length > 0) {
  console.log(`\n  Warning: ${missing.length} constellation HIP IDs not found in star data:`);
  console.log(`  ${missing.sort((a, b) => a - b).join(", ")}`);
}

console.log("\nDone!");
