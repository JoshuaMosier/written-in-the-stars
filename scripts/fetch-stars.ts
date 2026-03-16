import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Star {
  idx: number;  // compact sequential index (0..N-1), used for URL encoding
  id: number;
  hip?: number; // Hipparcos catalog number
  ra: number;
  dec: number;
  mag: number;
  ci?: number;  // B-V color index
  name?: string;
}

const OUTPUT_PATH = join(__dirname, "..", "src", "lib", "data", "stars.json");

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function main() {
  // HYG Database v41 from GitHub (main branch)
  const url =
    "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";

  console.log("Fetching HYG v41 database...");
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    console.error(`Failed to fetch: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const text = await res.text();
  const lines = text.split("\n");
  console.log(`Downloaded ${lines.length} lines`);

  const headers = parseCSVLine(lines[0]);
  console.log("Columns:", headers.join(", "));

  // Map column indices
  const col = (name: string) => {
    const idx = headers.indexOf(name);
    if (idx < 0) throw new Error(`Column "${name}" not found`);
    return idx;
  };

  const hrIdx = col("hr");
  const raradIdx = col("rarad");
  const decradIdx = col("decrad");
  const magIdx = col("mag");
  const properIdx = col("proper");
  const idIdx = col("id");
  const ciIdx = col("ci");

  const stars: Star[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);

    const magStr = cols[magIdx]?.trim();
    const raradStr = cols[raradIdx]?.trim();
    const decradStr = cols[decradIdx]?.trim();

    if (!magStr || !raradStr || !decradStr) continue;

    const mag = parseFloat(magStr);
    const rarad = parseFloat(raradStr);
    const decrad = parseFloat(decradStr);

    if (isNaN(mag) || isNaN(rarad) || isNaN(decrad)) continue;
    if (mag > 6.5) continue;

    // Use HR number if available, otherwise use HYG id
    const hrStr = cols[hrIdx]?.trim();
    const hr = hrStr ? parseInt(hrStr, 10) : NaN;
    const hygId = parseInt(cols[idIdx]?.trim() || "", 10);
    const id = !isNaN(hr) && hr > 0 ? hr : hygId;

    // Resolve Hipparcos ID from the HYG 'id' column (Hipparcos catalog number)
    const hipStr = cols[idIdx]?.trim();
    const hip = hipStr ? parseInt(hipStr, 10) : NaN;

    const star: Star = {
      idx: 0, // assigned after sorting
      id,
      ra: Math.round(rarad * 1e6) / 1e6,
      dec: Math.round(decrad * 1e6) / 1e6,
      mag: Math.round(mag * 100) / 100,
    };

    if (!isNaN(hip) && hip > 0) {
      star.hip = hip;
    }

    const ciStr = cols[ciIdx]?.trim();
    if (ciStr) {
      const ci = parseFloat(ciStr);
      if (!isNaN(ci)) {
        star.ci = Math.round(ci * 100) / 100;
      }
    }

    const proper = cols[properIdx]?.trim();
    if (proper && proper.length > 0) {
      star.name = proper;
    }

    stars.push(star);
  }

  // Sort by magnitude (brightest first), then assign sequential indices
  stars.sort((a, b) => a.mag - b.mag);
  for (let i = 0; i < stars.length; i++) stars[i].idx = i;

  console.log(`\nTotal stars with mag <= 6.5: ${stars.length}`);
  console.log(`Brightest: ${JSON.stringify(stars[0])}`);
  console.log(`Faintest: ${JSON.stringify(stars[stars.length - 1])}`);
  console.log(`Named stars: ${stars.filter((s) => s.name).length}`);

  // Ensure output directory exists
  const outDir = join(__dirname, "..", "src", "lib", "data");
  mkdirSync(outDir, { recursive: true });

  writeFileSync(OUTPUT_PATH, JSON.stringify(stars));
  const sizeMB = (Buffer.byteLength(JSON.stringify(stars)) / 1e6).toFixed(2);
  console.log(`\nWrote ${stars.length} stars to ${OUTPUT_PATH} (${sizeMB} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
