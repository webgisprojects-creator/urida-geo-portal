#!/usr/bin/env node
const DEFAULT_BBOX = {
  kanpur: [80.1968, 26.3351, 80.4727, 26.5338],
  up: [77.0, 23.5, 84.5, 31.0],
};

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  })
);

const baseUrl = (args.base || process.env.TILE_SEED_BASE || "http://localhost:8060").replace(/\/$/, "");
const city = String(args.city || "kanpur").toLowerCase();
const styles = String(args.styles || "osm,positron")
  .split(",")
  .map((style) => style.trim())
  .filter(Boolean);
const zooms = String(args.zooms || "10-14")
  .split(",")
  .flatMap((part) => {
    const [a, b] = part.split("-").map((v) => Number(v.trim()));
    if (!Number.isFinite(a)) return [];
    if (!Number.isFinite(b)) return [a];
    const out = [];
    for (let z = a; z <= b; z += 1) out.push(z);
    return out;
  });
const concurrency = Math.max(1, Number(args.concurrency || 8));
const bbox = (args.bbox ? String(args.bbox).split(",").map(Number) : DEFAULT_BBOX[city]) || DEFAULT_BBOX.kanpur;

if (!bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
  throw new Error("Invalid bbox. Use --bbox=minLon,minLat,maxLon,maxLat");
}

const lonToTileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTileY = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
};

const jobs = [];
for (const style of styles) {
  for (const z of zooms) {
    const minX = lonToTileX(bbox[0], z);
    const maxX = lonToTileX(bbox[2], z);
    const minY = latToTileY(bbox[3], z);
    const maxY = latToTileY(bbox[1], z);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        jobs.push({ style, z, x, y });
      }
    }
  }
}

let index = 0;
let ok = 0;
let fail = 0;
const started = Date.now();

const worker = async () => {
  while (index < jobs.length) {
    const job = jobs[index++];
    const url = `${baseUrl}/api/tiles/${job.style}/${job.z}/${job.x}/${job.y}.png`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ok += 1;
    } catch (err) {
      fail += 1;
      console.error(`FAIL ${job.style}/${job.z}/${job.x}/${job.y}: ${err.message}`);
    }
  }
};

console.log(
  `Seeding ${jobs.length} tiles base=${baseUrl} city=${city} styles=${styles.join(",")} zooms=${zooms.join(",")} concurrency=${concurrency}`
);
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`BASEMAP_SEED ok=${ok} fail=${fail} elapsedMs=${Date.now() - started}`);
if (fail) process.exitCode = 1;
