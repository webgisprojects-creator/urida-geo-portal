import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  STYLES,
  getMaskedTile,
  getGwcTileBuffer,
  fetchBoundaryRings,
  MERCATOR_ORIGIN,
} from "../routes/tiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// cityConfig.js is a client-only ES module (imports `ol/proj`), so it can't
// be `import`-ed directly into the Node server process. It's still the
// single source of truth for which GeoServer layers each city actually
// uses, so we parse the three fields we need straight out of the source
// file's text instead of duplicating a second, driftable registry.
const CITY_CONFIG_PATH = path.resolve(
  __dirname,
  "../../../client/src/assets/configs/cityConfig.js"
);

const UP_BOUNDARY = "Ward_38:Up_District";

// Cities are viewed much closer than the whole state, so they get a deeper
// zoom range; the UP-wide home view stays shallow. Matches the zoom bands
// actually reachable from each page's default `zoom`/max extent.
const CITY_ZOOM_RANGE = { min: 11, max: 16 };
const UP_ZOOM_RANGE = { min: 6, max: 10 };

// GWC tiles are cached with a 1-hour TTL (real, editable GIS data) vs. the
// basemap tiles' 30-day TTL (eternal third-party imagery) — re-warm only
// the short-TTL layer tiles on a recurring schedule, comfortably inside
// that TTL so a served tile is never more than a few minutes stale.
const GWC_REWARM_INTERVAL_MS = 45 * 60 * 1000;

// Fan-out concurrency for this module's own job queue. This is deliberately
// higher than geoserverLimiter/basemapLimiter's own caps (8/10) — those
// limiters gate the real network fetch inside getMaskedTile/getGwcTileBuffer
// and are shared with live user traffic. This number only controls how many
// warming jobs are in flight *asking* to run; every call below passes
// "low" priority (see concurrencyLimiter.js) so queued warming work always
// yields to a real request, rather than a plain FIFO queue letting a deep
// warmer backlog starve a request that arrives after it.
const WARM_FANOUT = 24;
const LOW_PRIORITY = "low";

export function parseCityRegistry() {
  const text = fs.readFileSync(CITY_CONFIG_PATH, "utf8");
  const lines = text.split(/\r?\n/);
  const cities = {};
  let currentKey = null;
  // Tracked by brace depth rather than a fixed indentation width (e.g. a
  // hardcoded "exactly 2 spaces") — a future reformat/re-indent of
  // cityConfig.js would silently break an indentation-based parser without
  // any error, just quietly-wrong (missing) cache warming. Depth 1 is
  // "inside cityConfig's top-level object" (where city keys like `agra: {`
  // live); depth 2 is "inside one city's object" (where zoneLayer/wardLayer/
  // roadLayer live) — this also correctly excludes deeper-nested fields
  // like roadClassifications.category.layer from being misread as the
  // city's own roadLayer.
  const keyRe = /^\s*(\w+):\s*\{\s*$/;
  const fieldRe = /^\s*(zoneLayer|wardLayer|roadLayer):\s*"([^"]+)"/;
  let depth = 0;

  for (const line of lines) {
    if (depth === 1) {
      const keyMatch = keyRe.exec(line);
      if (keyMatch) {
        currentKey = keyMatch[1];
        cities[currentKey] = {};
      }
    } else if (depth === 2 && currentKey) {
      const fieldMatch = fieldRe.exec(line);
      if (fieldMatch) {
        cities[currentKey][fieldMatch[1]] = fieldMatch[2];
      }
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
  }
  return cities;
}

function tileRangeForBbox(bbox, z) {
  const worldSize = 2 * MERCATOR_ORIGIN;
  const tileSize = worldSize / 2 ** z;
  const [minX, minY, maxX, maxY] = bbox;
  const maxIndex = 2 ** z - 1;
  return {
    xMin: Math.max(0, Math.floor((minX + MERCATOR_ORIGIN) / tileSize)),
    xMax: Math.min(maxIndex, Math.floor((maxX + MERCATOR_ORIGIN) / tileSize)),
    yMin: Math.max(0, Math.floor((MERCATOR_ORIGIN - maxY) / tileSize)),
    yMax: Math.min(maxIndex, Math.floor((MERCATOR_ORIGIN - minY) / tileSize)),
  };
}

function* tilesForBbox(bbox, zoomRange) {
  for (let z = zoomRange.min; z <= zoomRange.max; z += 1) {
    const { xMin, xMax, yMin, yMax } = tileRangeForBbox(bbox, z);
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        yield { z, x, y };
      }
    }
  }
}

async function runQueue(jobs, concurrency) {
  let index = 0;
  let ok = 0;
  let fail = 0;
  const worker = async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      try {
        await job();
        ok += 1;
      } catch {
        fail += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) || 1 }, worker));
  return { ok, fail };
}

async function warmGwcForLayer(layer, boundary, zoomRange) {
  const { bbox } = await fetchBoundaryRings(boundary, LOW_PRIORITY);
  const jobs = [];
  for (const tile of tilesForBbox(bbox, zoomRange)) {
    jobs.push(() => getGwcTileBuffer(layer, tile.z, tile.x, tile.y, LOW_PRIORITY));
  }
  return runQueue(jobs, WARM_FANOUT);
}

async function warmCityGwcLayers(city, boundary) {
  let ok = 0;
  let fail = 0;
  for (const layerKey of ["zoneLayer", "wardLayer", "roadLayer"]) {
    const layer = city[layerKey];
    if (!layer) continue;
    const result = await warmGwcForLayer(layer, boundary, CITY_ZOOM_RANGE);
    ok += result.ok;
    fail += result.fail;
  }
  return { ok, fail };
}

// One-time pass: UP-wide + every city's basemap tiles (30-day cache, so a
// single pass is enough) and a first GWC pass for each city's boundary/road
// layers. Intended to run once at server startup, fire-and-forget.
//
// Priority-tiered by zoom, not by city: a naive city-by-city sweep would
// fully finish city #1 down to street level while city #17 sits completely
// cold for hours (17 cities x 6 styles x z11-16 is a genuinely large job).
// Instead this warms the shallowest zoom level across *every* city (and the
// UP-wide view) first, then progressively deeper — so the city-overview
// tiles most users see first are ready everywhere early in the run, instead
// of only in whichever city happened to be warmed first.
export async function warmAllCaches({
  cityZoomRange = CITY_ZOOM_RANGE,
  upZoomRange = UP_ZOOM_RANGE,
} = {}) {
  const startedAt = Date.now();
  const cities = parseCityRegistry();
  const cityEntries = Object.entries(cities)
    .map(([key, city]) => ({ key, city, boundary: city.zoneLayer || city.wardLayer }))
    .filter((entry) => {
      if (!entry.boundary) {
        console.warn(`[cache-warmer] skipping ${entry.key}: no zoneLayer/wardLayer configured`);
        return false;
      }
      return true;
    });

  const bboxByBoundary = new Map();
  try {
    bboxByBoundary.set(UP_BOUNDARY, (await fetchBoundaryRings(UP_BOUNDARY, LOW_PRIORITY)).bbox);
  } catch (err) {
    console.warn(`[cache-warmer] UP-wide boundary fetch failed: ${err.message}`);
  }
  for (const entry of cityEntries) {
    try {
      bboxByBoundary.set(entry.boundary, (await fetchBoundaryRings(entry.boundary, LOW_PRIORITY)).bbox);
    } catch (err) {
      console.warn(`[cache-warmer] boundary fetch failed for ${entry.key}: ${err.message}`);
    }
  }

  let totals = { ok: 0, fail: 0 };
  const maxZoom = Math.max(cityZoomRange.max, upZoomRange.max);

  for (let z = Math.min(cityZoomRange.min, upZoomRange.min); z <= maxZoom; z += 1) {
    const jobs = [];

    if (z >= upZoomRange.min && z <= upZoomRange.max && bboxByBoundary.has(UP_BOUNDARY)) {
      const bbox = bboxByBoundary.get(UP_BOUNDARY);
      for (const style of Object.keys(STYLES)) {
        for (const tile of tilesForBbox(bbox, { min: z, max: z })) {
          jobs.push(() => getMaskedTile(style, UP_BOUNDARY, tile.z, tile.x, tile.y, LOW_PRIORITY));
        }
      }
    }

    if (z >= cityZoomRange.min && z <= cityZoomRange.max) {
      for (const entry of cityEntries) {
        const bbox = bboxByBoundary.get(entry.boundary);
        if (!bbox) continue;
        for (const style of Object.keys(STYLES)) {
          for (const tile of tilesForBbox(bbox, { min: z, max: z })) {
            jobs.push(() => getMaskedTile(style, entry.boundary, tile.z, tile.x, tile.y, LOW_PRIORITY));
          }
        }
        for (const layerKey of ["zoneLayer", "wardLayer", "roadLayer"]) {
          const layer = entry.city[layerKey];
          if (!layer) continue;
          for (const tile of tilesForBbox(bbox, { min: z, max: z })) {
            jobs.push(() => getGwcTileBuffer(layer, tile.z, tile.x, tile.y, LOW_PRIORITY));
          }
        }
      }
    }

    if (!jobs.length) continue;
    const result = await runQueue(jobs, WARM_FANOUT);
    totals.ok += result.ok;
    totals.fail += result.fail;
    console.log(
      `[cache-warmer] zoom ${z} done: ${result.ok} ok, ${result.fail} failed, ${jobs.length} jobs (${((Date.now() - startedAt) / 1000).toFixed(0)}s elapsed)`
    );
  }

  console.log(
    `[cache-warmer] initial pass complete: ${cityEntries.length} cities, ${totals.ok} tiles ok, ${totals.fail} failed, ${((Date.now() - startedAt) / 1000).toFixed(0)}s total`
  );
}

// Recurring pass: GWC layers only (1-hour TTL). Basemap tiles are skipped
// here on purpose — they're cached 30 days and already warmed by the
// one-time pass, so re-running them on a 45-minute timer would just be
// wasted upstream traffic against third-party tile providers.
async function rewarmGwcOnly() {
  const startedAt = Date.now();
  const cities = parseCityRegistry();
  let totals = { ok: 0, fail: 0 };

  for (const key of Object.keys(cities)) {
    const city = cities[key];
    const boundary = city.zoneLayer || city.wardLayer;
    if (!boundary) continue;
    try {
      const result = await warmCityGwcLayers(city, boundary);
      totals.ok += result.ok;
      totals.fail += result.fail;
    } catch (err) {
      console.warn(`[cache-warmer] GWC re-warm failed for ${key}: ${err.message}`);
    }
  }

  console.log(
    `[cache-warmer] GWC re-warm complete: ${totals.ok} tiles ok, ${totals.fail} failed, ${((Date.now() - startedAt) / 1000).toFixed(0)}s`
  );
}

// Starts the whole pre-warming lifecycle: one initial full pass (basemaps +
// GWC), then a recurring GWC-only re-warm on a timer. Fire-and-forget by
// design — never blocks server startup, never throws past this call.
export function startCacheWarmer() {
  warmAllCaches().catch((err) => console.error("[cache-warmer] initial pass failed:", err));
  setInterval(() => {
    rewarmGwcOnly().catch((err) => console.error("[cache-warmer] GWC re-warm failed:", err));
  }, GWC_REWARM_INTERVAL_MS);
}
