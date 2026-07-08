// Answers "does every basemap actually work at every zoom level?" with
// evidence instead of assumption: for each style in the tile proxy's
// registry, fetches a real tile at every zoom from that style's minimum to
// its client-side max (matching the maxZoom each layer declares in
// MapContainer.jsx/HomePage.js), centered on Lucknow. Uses the server's own
// getRawTileBuffer, so it exercises the exact same mirror-rotation, retry,
// disk-cache and rate-limit path a live user request takes — a pass here
// means the style works end to end, not just that the CDN answered a ping.
//
// Usage: node scripts/verify-basemaps.mjs [lon] [lat]
import { STYLES, getRawTileBuffer } from "../server/src/routes/tiles.js";

const lon = Number(process.argv[2]) || 80.9462; // Lucknow
const lat = Number(process.argv[3]) || 26.8467;

// Client-side maxZoom per style (MapContainer.jsx / HomePage.js layer defs).
const CLIENT_MAX_ZOOM = {
  osm: 19,
  positron: 20,
  toner: 20,
  topo: 17,
  satellite: 18,
  labels: 18,
};
const MIN_ZOOM = 6;

function lonLatToTile(lonDeg, latDeg, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lonDeg + 180) / 360) * n);
  const rad = (latDeg * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

let anyFailure = false;

for (const style of Object.keys(STYLES)) {
  const maxZoom = CLIENT_MAX_ZOOM[style] ?? 18;
  const results = [];
  for (let z = MIN_ZOOM; z <= maxZoom; z += 1) {
    const { x, y } = lonLatToTile(lon, lat, z);
    const startedAt = Date.now();
    const meta = {};
    try {
      const buffer = await getRawTileBuffer(style, z, x, y, "low", meta);
      const looksLikeImage =
        buffer &&
        buffer.length > 0 &&
        (buffer.subarray(0, 4).equals(PNG_MAGIC) || buffer.subarray(0, 3).equals(JPG_MAGIC));
      results.push({
        z,
        ok: Boolean(looksLikeImage),
        bytes: buffer?.length ?? 0,
        ms: Date.now() - startedAt,
        cache: meta.cacheHit ? "HIT" : "MISS",
        note: looksLikeImage ? "" : "not an image",
      });
      if (!looksLikeImage) anyFailure = true;
    } catch (err) {
      results.push({ z, ok: false, ms: Date.now() - startedAt, note: err.message });
      anyFailure = true;
    }
  }

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${style} (z${MIN_ZOOM}-${maxZoom}): ${results.length - failures.length}/${results.length} zoom levels OK`
  );
  for (const r of results) {
    const status = r.ok ? "OK  " : "FAIL";
    console.log(
      `  z${String(r.z).padStart(2)} ${status} ${String(r.bytes ?? 0).padStart(7)}B ${String(r.ms).padStart(5)}ms ${r.cache || ""} ${r.note}`
    );
  }
}

console.log(anyFailure ? "\nRESULT: FAILURES FOUND (see above)" : "\nRESULT: all styles OK at every zoom level");
process.exit(anyFailure ? 1 : 0);
