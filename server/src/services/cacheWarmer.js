import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  STYLES,
  getMaskedTile,
  getGwcTileBuffer,
  fetchBoundaryRings,
  tileBounds3857,
  bboxIntersects,
  MERCATOR_ORIGIN,
  probeUpstreamConnectivity,
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
// Env-tunable (TILE_WARM_CITY_MAX_ZOOM / TILE_WARM_UP_MAX_ZOOM) so a
// staging box preparing a full MBTiles package for production can warm
// deeper than the day-to-day defaults without a code change. Be aware of
// the real, measured cost curve before raising the city max: each +1 zoom
// level roughly quadruples that band's tile count — the initial z16 pass
// measured 285k tiles / ~5.2 hours / most of the cache's disk usage, so
// z17 is ~1.1M tiles / ~20 hours / ~16GB (needs TILE_CACHE_CAP_GB raised
// in step, or the hourly eviction sweep will evict tiles the warmer just
// fetched). The warm is resumable across restarts (already-cached tiles
// are millisecond stat-hits), so deep warms can be completed across
// several sessions. Zooms beyond the warmed max still work fine live -
// fetched on demand, cached, and included in the next MBTiles export.
const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};
const CITY_ZOOM_RANGE = { min: 11, max: envInt("TILE_WARM_CITY_MAX_ZOOM", 16) };
const UP_ZOOM_RANGE = { min: 6, max: envInt("TILE_WARM_UP_MAX_ZOOM", 11) };

// Per-style deep-warm ceiling inside city boundaries (beyond the shared
// CITY_ZOOM_RANGE the GWC layers use). Chosen for an air-gapped deployment
// where the archive is the only truth: satellite/labels/topo are warmed to
// the exact max zoom the client can request, making those styles literally
// 100% complete offline; osm/positron/toner stop at 17/16 because vector
// cartography upscales gracefully through the ancestor-tile fallback
// (tiles.js), whereas satellite imagery is where blur is actually
// noticeable. Deep-zoom warming is clipped to the real city boundary
// polygon (not its rectangle) — see tileIntersectsRings below — which cuts
// the deep-tile count roughly in half.
const STYLE_WARM_MAX_ZOOM = {
  osm: envInt("TILE_WARM_MAX_OSM", 17),
  positron: envInt("TILE_WARM_MAX_POSITRON", 16),
  toner: envInt("TILE_WARM_MAX_TONER", 16),
  topo: envInt("TILE_WARM_MAX_TOPO", 17), // client max 17 — complete
  satellite: envInt("TILE_WARM_MAX_SATELLITE", 18), // client max 18 — complete
  labels: envInt("TILE_WARM_MAX_LABELS", 18), // client max 18 — complete
};
// Below this zoom a city's bounding rectangle is close enough to its real
// shape that polygon-clipping isn't worth the per-tile geometry test.
const RING_CLIP_MIN_ZOOM = 15;

// How often to re-probe for connectivity after a warm pass came back with
// failures (the air-gapped case: the internet window isn't open yet or
// closed partway through). The warm is resumable — cached tiles are
// millisecond stat-hits — so re-running it after a probe succeeds only
// costs the tiles still actually missing.
const CONNECTIVITY_RECHECK_MS = envInt("TILE_WARM_RECHECK_MINUTES", 10) * 60 * 1000;

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
  // roadClassifications' own layers (Roads by category/condition/material/
  // ownership/cus/zone) use a static named GeoServer style per layer, same
  // as roadLayer — structurally just as cacheable, just never included in
  // the warming loop below until now. Confirmed via real telemetry these
  // averaged 7-28s/view specifically because nothing ever pre-warmed them.
  const roadClassStartRe = /^\s*roadClassifications:\s*\{\s*$/;
  const layerFieldRe = /\blayer:\s*"([^"]+)"/;
  let depth = 0;
  let inClassifications = false;
  let classificationsEnterDepth = null;

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
      if (roadClassStartRe.test(line)) {
        inClassifications = true;
        classificationsEnterDepth = depth;
      }
    } else if (inClassifications && currentKey) {
      const layerMatch = layerFieldRe.exec(line);
      if (layerMatch) {
        if (!cities[currentKey].roadClassificationLayers) {
          cities[currentKey].roadClassificationLayers = [];
        }
        cities[currentKey].roadClassificationLayers.push(layerMatch[1]);
      }
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (inClassifications && depth <= classificationsEnterDepth) {
      inClassifications = false;
      classificationsEnterDepth = null;
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

// True when a tile's bbox actually touches the boundary polygon (any ring),
// not just the polygon's bounding rectangle. Standard rect-vs-polygon test:
// coarse ring-bbox reject, then (a) any ring vertex inside the rect, (b) any
// rect corner inside the ring (ray cast), (c) any ring segment crossing a
// rect edge — covering the "polygon edge passes through the tile without
// either's vertices inside the other" case.
function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const orient = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4;
}

function tileIntersectsRings(tileBBox, ringsWithBbox) {
  const [minX, minY, maxX, maxY] = tileBBox;
  const rectEdges = [
    [minX, minY, maxX, minY],
    [maxX, minY, maxX, maxY],
    [maxX, maxY, minX, maxY],
    [minX, maxY, minX, minY],
  ];
  for (const { ring, bbox } of ringsWithBbox) {
    if (!bboxIntersects(bbox, tileBBox)) continue;
    for (const [px, py] of ring) {
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) return true;
    }
    if (pointInRing(minX, minY, ring)) return true;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      for (const [ex1, ey1, ex2, ey2] of rectEdges) {
        if (segmentsIntersect(x1, y1, x2, y2, ex1, ey1, ex2, ey2)) return true;
      }
    }
  }
  return false;
}

function ringsWithBboxes(rings) {
  return (rings || []).map((ring) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { ring, bbox: [minX, minY, maxX, maxY] };
  });
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
  const layers = [
    ...["zoneLayer", "wardLayer", "roadLayer"].map((k) => city[k]).filter(Boolean),
    ...(city.roadClassificationLayers || []),
  ];
  for (const layer of layers) {
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

  const boundaryData = new Map(); // boundary -> { bbox, clipRings }
  const loadBoundary = async (boundary, label) => {
    try {
      const { rings, bbox } = await fetchBoundaryRings(boundary, LOW_PRIORITY);
      boundaryData.set(boundary, { bbox, clipRings: ringsWithBboxes(rings) });
    } catch (err) {
      console.warn(`[cache-warmer] boundary fetch failed for ${label}: ${err.message}`);
    }
  };
  await loadBoundary(UP_BOUNDARY, "UP-wide");
  for (const entry of cityEntries) {
    await loadBoundary(entry.boundary, entry.key);
  }

  let totals = { ok: 0, fail: 0 };
  const styleMaxOverall = Math.max(...Object.values(STYLE_WARM_MAX_ZOOM));
  const maxZoom = Math.max(cityZoomRange.max, upZoomRange.max, styleMaxOverall);

  for (let z = Math.min(cityZoomRange.min, upZoomRange.min); z <= maxZoom; z += 1) {
    const jobs = [];

    if (z >= upZoomRange.min && z <= upZoomRange.max && boundaryData.has(UP_BOUNDARY)) {
      const { bbox } = boundaryData.get(UP_BOUNDARY);
      for (const style of Object.keys(STYLES)) {
        for (const tile of tilesForBbox(bbox, { min: z, max: z })) {
          jobs.push(() => getMaskedTile(style, UP_BOUNDARY, tile.z, tile.x, tile.y, LOW_PRIORITY));
        }
      }
    }

    if (z >= cityZoomRange.min) {
      for (const entry of cityEntries) {
        const data = boundaryData.get(entry.boundary);
        if (!data) continue;
        const { bbox, clipRings } = data;
        // Basemap styles: each warms as deep as its own configured max.
        // Past RING_CLIP_MIN_ZOOM only tiles that genuinely touch the
        // city's boundary polygon are fetched — a city's bounding
        // rectangle is mostly not-city at street-level zooms.
        for (const style of Object.keys(STYLES)) {
          const styleMax = STYLE_WARM_MAX_ZOOM[style] ?? cityZoomRange.max;
          if (z > styleMax) continue;
          for (const tile of tilesForBbox(bbox, { min: z, max: z })) {
            if (
              z >= RING_CLIP_MIN_ZOOM &&
              clipRings.length &&
              !tileIntersectsRings(tileBounds3857(tile.z, tile.x, tile.y), clipRings)
            ) {
              continue;
            }
            jobs.push(() => getMaskedTile(style, entry.boundary, tile.z, tile.x, tile.y, LOW_PRIORITY));
          }
        }
        // GWC overlay layers (internal GeoServer) keep the shared city
        // zoom range — they're re-warmed on a rolling schedule anyway.
        if (z <= cityZoomRange.max) {
          const cityLayers = [
            ...["zoneLayer", "wardLayer", "roadLayer"].map((k) => entry.city[k]).filter(Boolean),
            ...(entry.city.roadClassificationLayers || []),
          ];
          for (const layer of cityLayers) {
            for (const tile of tilesForBbox(bbox, { min: z, max: z })) {
              jobs.push(() => getGwcTileBuffer(layer, tile.z, tile.x, tile.y, LOW_PRIORITY));
            }
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
  return totals;
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
// Once the initial pass completes, the freshly-warmed cache is packaged
// into per-style .mbtiles archives (server/mbtiles/) automatically, so a
// staging box that finished warming always has portable archives ready for
// the manual production migration. Per-style staleness checks inside the
// exporter make this near-free on restarts where nothing new was fetched.
// Set TILE_MBTILES_EXPORT=0 to disable (e.g. on a dev machine where
// rewriting multi-hundred-MB archives after every warm is unwanted).
export function startCacheWarmer() {
  warmAllCaches()
    .then(async () => {
      if (process.env.TILE_MBTILES_EXPORT === "0") return;
      const { exportAllMbtiles } = await import("./mbtilesExport.js");
      exportAllMbtiles();
    })
    .catch((err) => console.error("[cache-warmer] initial pass failed:", err));
  setInterval(() => {
    rewarmGwcOnly().catch((err) => console.error("[cache-warmer] GWC re-warm failed:", err));
  }, GWC_REWARM_INTERVAL_MS);
}
