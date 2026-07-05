import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { geoserverLimiter, basemapLimiter } from "../utils/concurrencyLimiter.js";
import { verifyToken } from "../middleware/authMiddleware.js";
import { isKnownGeoserverLayer } from "../utils/knownGeoserverLayers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Every page that loads tiles (HomePage, Dashboard) is already behind the
// client's <Protected> login gate, so this is transparent to real users —
// the browser's same-origin auth cookie is sent automatically with every
// tile <img> request. This module's own internal warming calls
// (server/src/services/cacheWarmer.js) call getMaskedTile/getGwcTileBuffer
// directly as functions, never through this router, so they're unaffected.
router.use(verifyToken);

// Disk cache root — one subdirectory per basemap style, mirroring the
// z/x/y tile pyramid. Gitignored; grows/shrinks at runtime.
const CACHE_ROOT = path.join(__dirname, "..", "..", "tile-cache");

// Cap + safety margin for the automatic eviction sweep. Kept well under a
// typical small VPS's free disk, and "smart managed" per the requirement
// that this must never slow the app down — the sweep runs on a timer, off
// the request path, so serving tiles is never blocked by it.
const CACHE_CAP_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const CACHE_PRUNE_TARGET_BYTES = 4 * 1024 * 1024 * 1024; // prune back down to 4GB
const EVICTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Each style's upstream mirrors — the proxy rotates across these the same
// way the client used to rotate across a tile provider's own {a,b,c} /
// {1-4} subdomains, just now happening server-side so the disk cache is
// shared across every user instead of each browser caching independently.
// "toner" was Stamen (now dead, migrated to a paid-only Stadia Maps
// endpoint) — replaced with CartoDB Dark Matter, the closest free
// high-contrast dark style, on the same reliable CARTO infrastructure
// already used for Positron.
const STYLES = {
  osm: {
    mirrors: ["a", "b", "c"].map(
      (s) => `https://${s}.tile.openstreetmap.org/{z}/{x}/{y}.png`
    ),
    attribution: "OpenStreetMap contributors",
  },
  positron: {
    mirrors: [1, 2, 3, 4].map(
      (s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`
    ),
    attribution: "CARTO / OpenStreetMap contributors",
  },
  toner: {
    // Replacement for the dead Stamen Toner endpoint.
    mirrors: [1, 2, 3, 4].map(
      (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`
    ),
    attribution: "CARTO / OpenStreetMap contributors",
  },
  topo: {
    mirrors: ["a", "b", "c"].map(
      (s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`
    ),
    attribution: "OpenTopoMap / SRTM / OpenStreetMap contributors",
  },
  satellite: {
    // Esri's World_Imagery — single origin, no subdomain rotation on offer.
    mirrors: [
      "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Esri World Imagery",
  },
  labels: {
    // The Esri reference-labels overlay drawn on top of satellite.
    mirrors: [
      "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Esri",
  },
};

// In-flight de-duplication: if many users request the same uncached tile
// at once (very likely — everyone's looking at roughly the same map
// area), only the first triggers an upstream fetch; the rest await the
// same promise instead of each firing their own request at the upstream
// provider. This is what keeps a burst of concurrent users from tripping
// a free provider's rate limit.
const inFlight = new Map();

function tileCachePath(style, z, x, y) {
  return path.join(CACHE_ROOT, style, String(z), String(x), `${y}.png`);
}

// Mirrors ordered starting from a deterministic-but-distributed pick (same
// idea as the {a,b,c}/{1-4} subdomain rotation the client used to rely on
// directly), wrapping around so every mirror gets tried before giving up.
function orderedMirrors(style, z, x, y) {
  const cfg = STYLES[style];
  if (!cfg) return [];
  const mirrors = cfg.mirrors;
  const start = (x + y + z) % mirrors.length;
  return mirrors.map((_, i) => mirrors[(start + i) % mirrors.length]);
}

function buildUrl(template, z, x, y) {
  return template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

// A single flaky/slow mirror should never make a tile request hang for the
// default fetch timeout — fail fast (5s) and fall through to the next
// mirror. This is what actually delivers on "rotation so it doesn't break
// under load": a single provider having a bad moment doesn't block users.
const PER_MIRROR_TIMEOUT_MS = 5000;

// Node's native fetch (undici) attempts IPv6 first (Happy Eyeballs) and, on
// this host, that hangs for several seconds against OSM's Fastly-fronted
// tile servers before falling back — confirmed from the live server's own
// logs (constant "This operation was aborted" for every osm/* tile, not a
// one-off). curl against the identical URL succeeds in ~2s over IPv4. Using
// Node's core http/https client with `family: 4` skips the IPv6 attempt
// entirely instead of just timing it out faster.
function fetchViaHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(
      url,
      {
        family: 4,
        headers: { "User-Agent": "urida-geo-portal-tile-proxy/1.0" },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // drain so the socket can be reused/closed cleanly
          reject(new Error(`Upstream tile fetch failed: ${res.statusCode} ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

async function fetchAndCacheTile(style, z, x, y, priority = "normal") {
  const mirrors = orderedMirrors(style, z, x, y);
  if (!mirrors.length) return null;

  const limit = priority === "low" ? basemapLimiter.low : basemapLimiter;
  let lastError = null;
  for (const template of mirrors) {
    const url = buildUrl(template, z, x, y);
    try {
      const buffer = await limit(() => fetchViaHttp(url, PER_MIRROR_TIMEOUT_MS));

      const filePath = tileCachePath(style, z, x, y);
      await ensureDir(path.dirname(filePath));
      await fs.promises.writeFile(filePath, buffer);

      return buffer;
    } catch (err) {
      lastError = err;
      // try the next mirror
    }
  }
  throw lastError || new Error(`All mirrors failed for ${style} ${z}/${x}/${y}`);
}

// Cache-hit-or-fetch for a plain (unclipped) tile — shared by the direct
// route and the boundary-masking path below, so a masked tile's source
// pixels come from the exact same shared/deduped disk cache as everyone
// else's unclipped requests.
//
// `priority`: "normal" (default, real user requests via the HTTP routes
// below) or "low" (server/src/services/cacheWarmer.js's background warming
// — see concurrencyLimiter.js for why this exists: without it, a warming
// pass in progress could starve a real request queued behind it).
async function getRawTileBuffer(style, z, x, y, priority = "normal") {
  const filePath = tileCachePath(style, z, x, y);
  const cacheKey = `${style}/${z}/${x}/${y}`;

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat) {
    const now = new Date();
    fs.promises.utimes(filePath, now, now).catch(() => {});
    return fs.promises.readFile(filePath);
  }

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = fetchAndCacheTile(style, z, x, y, priority).finally(() => {
      inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------
// Boundary-clipped tiles: mask a basemap tile to a real (irregular) admin
// boundary shape server-side, once, then cache and reuse the masked PNG
// for every subsequent request — instead of asking every browser to
// redraw the same clip via canvas on every frame. Opt-in via
// `?boundary=<workspace:layer>` on the tile route below; omitting it keeps
// the original unclipped behavior unchanged.
// ---------------------------------------------------------------------
const BOUNDARY_CACHE_ROOT = path.join(__dirname, "..", "..", "boundary-cache");
const GEOSERVER_UPSTREAM_BASE = (
  process.env.GEOSERVER_PROXY_TARGET || "http://localhost:8080/geoserver"
).replace(/\/$/, "");
// City/state boundaries change essentially never — refetch at most daily.
const BOUNDARY_TTL_MS = 24 * 60 * 60 * 1000;
const BOUNDARY_FETCH_TIMEOUT_MS = 20000;

const boundaryMemoryCache = new Map(); // safeKey -> { rings, bbox, fetchedAt }

function safeBoundaryKey(boundaryRaw) {
  return String(boundaryRaw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Flattens a GeoJSON FeatureCollection's Polygon/MultiPolygon geometries
// into plain [x, y] coordinate rings (already in EPSG:3857 — the WFS
// request below asks for that SRS directly) plus their combined bbox.
function ringsFromGeoJson(geojson) {
  const rings = [];
  let bbox = null;
  const extend = (x, y) => {
    if (!bbox) bbox = [x, y, x, y];
    else {
      if (x < bbox[0]) bbox[0] = x;
      if (y < bbox[1]) bbox[1] = y;
      if (x > bbox[2]) bbox[2] = x;
      if (y > bbox[3]) bbox[3] = y;
    }
  };
  const addPolygon = (coords) => {
    (coords || []).forEach((ring) => {
      rings.push(ring);
      ring.forEach(([x, y]) => extend(x, y));
    });
  };
  (geojson?.features || []).forEach((feature) => {
    const geom = feature?.geometry;
    if (!geom) return;
    if (geom.type === "Polygon") addPolygon(geom.coordinates);
    else if (geom.type === "MultiPolygon") (geom.coordinates || []).forEach(addPolygon);
  });
  return { rings, bbox };
}

async function fetchBoundaryRings(boundaryRaw, priority = "normal") {
  const safeKey = safeBoundaryKey(boundaryRaw);
  const cached = boundaryMemoryCache.get(safeKey);
  if (cached && Date.now() - cached.fetchedAt < BOUNDARY_TTL_MS) return cached;

  const diskPath = path.join(BOUNDARY_CACHE_ROOT, `${safeKey}.json`);
  try {
    const stat = await fs.promises.stat(diskPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < BOUNDARY_TTL_MS) {
      const entry = JSON.parse(await fs.promises.readFile(diskPath, "utf-8"));
      boundaryMemoryCache.set(safeKey, entry);
      return entry;
    }
  } catch {
    // fall through to a fresh fetch
  }

  const url =
    `${GEOSERVER_UPSTREAM_BASE}/wfs?service=WFS&version=1.1.0&request=GetFeature` +
    `&typeName=${encodeURIComponent(boundaryRaw)}&outputFormat=application/json` +
    `&srsName=EPSG:3857`;
  const limit = priority === "low" ? geoserverLimiter.low : geoserverLimiter;
  const buffer = await limit(() => fetchViaHttp(url, BOUNDARY_FETCH_TIMEOUT_MS));
  const geojson = JSON.parse(buffer.toString("utf-8"));
  const { rings, bbox } = ringsFromGeoJson(geojson);
  const entry = { rings, bbox, fetchedAt: Date.now() };

  boundaryMemoryCache.set(safeKey, entry);
  await ensureDir(BOUNDARY_CACHE_ROOT);
  fs.promises.writeFile(diskPath, JSON.stringify(entry)).catch(() => {});
  return entry;
}

// Standard Web Mercator (EPSG:3857) tile bounds for a given z/x/y at tile
// size 256 — matches both OL's default XYZ grid and GeoServer/GWC's
// GoogleMapsCompatible gridset, so this lines up with what the client
// actually requests.
const MERCATOR_ORIGIN = Math.PI * 6378137; // 20037508.342789244
function tileBounds3857(z, x, y) {
  const worldSize = 2 * MERCATOR_ORIGIN;
  const tileSize = worldSize / 2 ** z;
  const minX = -MERCATOR_ORIGIN + x * tileSize;
  const maxX = minX + tileSize;
  const maxY = MERCATOR_ORIGIN - y * tileSize;
  const minY = maxY - tileSize;
  return [minX, minY, maxX, maxY];
}

function bboxIntersects(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// Builds a 256x256 SVG mask: solid shape on a transparent background — only
// the alpha channel matters, consumed via sharp's `dest-in` blend below.
// `evenodd` unions disjoint boundary pieces (e.g. every zone in a city) and
// subtracts real holes, regardless of the source data's ring winding.
function buildMaskSvg(rings, tileBBox) {
  const [minX, minY, maxX, maxY] = tileBBox;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const pathData = rings
    .map((ring) => {
      const points = ring.map(([x, y], i) => {
        const px = ((x - minX) / spanX) * 256;
        const py = ((maxY - y) / spanY) * 256; // mercator Y increases up; pixel Y increases down
        return `${i === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
      });
      return `${points.join(" ")} Z`;
    })
    .join(" ");
  return (
    `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${pathData}" fill="#fff" fill-rule="evenodd"/></svg>`
  );
}

function maskedTileCachePath(style, safeKey, z, x, y) {
  return path.join(CACHE_ROOT, style, safeKey, String(z), String(x), `${y}.png`);
}

// 1x1 fully-transparent PNG — cheap short-circuit for tiles that don't
// intersect the boundary at all (no upstream fetch, no compositing).
const TRANSPARENT_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function getMaskedTile(style, boundaryRaw, z, x, y, priority = "normal") {
  const safeKey = safeBoundaryKey(boundaryRaw);
  const filePath = maskedTileCachePath(style, safeKey, z, x, y);

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat) {
    const now = new Date();
    fs.promises.utimes(filePath, now, now).catch(() => {});
    return fs.promises.readFile(filePath);
  }

  const { rings, bbox } = await fetchBoundaryRings(boundaryRaw, priority);
  const tileBBox = tileBounds3857(Number(z), Number(x), Number(y));

  if (!rings.length || !bboxIntersects(bbox, tileBBox)) {
    return TRANSPARENT_TILE;
  }

  const rawBuffer = await getRawTileBuffer(style, z, x, y, priority);
  const maskSvg = buildMaskSvg(rings, tileBBox);
  const maskBuffer = await sharp(Buffer.from(maskSvg)).png().toBuffer();
  const masked = await sharp(rawBuffer)
    .ensureAlpha()
    .composite([{ input: maskBuffer, blend: "dest-in" }])
    .png()
    .toBuffer();

  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, masked);
  return masked;
}

// ---------------------------------------------------------------------
// GeoServer/GWC overlay-layer tile cache: Zone/Ward Boundary, Road
// Network, road classifications, LCLU, etc. Confirmed via direct testing
// on the GeoServer host itself that GWC's own cache is fast (~5ms) — the
// slowness users see is pure network round-trip from this app server to
// wherever GeoServer lives, paid on *every single tile, for every user,
// every time*, since nothing local was caching these before (unlike the
// basemap tiles above). This mirrors that same cache, just fetching from
// our own GeoServer's GWC instead of third-party basemap providers, with
// a much shorter TTL since this is real, editable GIS data rather than
// eternal basemap imagery — a stale cached tile should self-heal within
// the hour rather than needing a manual cache bust.
// ---------------------------------------------------------------------
const GWC_TILE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GWC_FETCH_TIMEOUT_MS = 15000;

function safeGwcLayerKey(layerRaw) {
  return String(layerRaw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function gwcTileCachePath(layerRaw, z, x, y) {
  return path.join(CACHE_ROOT, "gwc", safeGwcLayerKey(layerRaw), String(z), String(x), `${y}.png`);
}

async function fetchAndCacheGwcTile(layerRaw, z, x, y, priority = "normal") {
  const [minX, minY, maxX, maxY] = tileBounds3857(Number(z), Number(x), Number(y));
  const url =
    `${GEOSERVER_UPSTREAM_BASE}/gwc/service/wms?service=WMS&version=1.1.1&request=GetMap` +
    `&layers=${encodeURIComponent(layerRaw)}&bbox=${minX},${minY},${maxX},${maxY}` +
    `&width=256&height=256&srs=EPSG:3857&format=image/png&transparent=true&tiled=true`;
  const limit = priority === "low" ? geoserverLimiter.low : geoserverLimiter;
  const buffer = await limit(() => fetchViaHttp(url, GWC_FETCH_TIMEOUT_MS));
  const filePath = gwcTileCachePath(layerRaw, z, x, y);
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, buffer);
  return buffer;
}

async function getGwcTileBuffer(layerRaw, z, x, y, priority = "normal") {
  const filePath = gwcTileCachePath(layerRaw, z, x, y);
  const cacheKey = `gwc/${safeGwcLayerKey(layerRaw)}/${z}/${x}/${y}`;

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs < GWC_TILE_TTL_MS) {
    return fs.promises.readFile(filePath);
  }

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = fetchAndCacheGwcTile(layerRaw, z, x, y, priority).finally(() => {
      inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, pending);
  }
  try {
    return await pending;
  } catch (err) {
    if (stat) return fs.promises.readFile(filePath); // serve stale over nothing
    throw err;
  }
}

router.get("/api/gwc-tiles/:layerPath/:z/:x/:y.png", async (req, res) => {
  const { layerPath, z, x, y } = req.params;
  if (!layerPath) {
    return res.status(400).json({ error: "Missing layer" });
  }
  // layerPath is used directly as GeoServer's WMS `layers=` param — restrict
  // it to layers this app actually knows about (derived from cityConfig.js)
  // rather than letting an authenticated-but-arbitrary caller probe/request
  // any layer name on the shared GeoServer instance.
  if (!isKnownGeoserverLayer(layerPath)) {
    return res.status(400).json({ error: "Unknown layer" });
  }
  try {
    const buffer = await getGwcTileBuffer(layerPath, z, x, y);
    // Much shorter than basemap tiles — this is real, editable GIS data,
    // not eternal imagery.
    res.set("Cache-Control", "public, max-age=300");
    res.type("png");
    return res.send(buffer);
  } catch (err) {
    console.error("GWC tile proxy error:", layerPath, `${z}/${x}/${y}`, err.message);
    return res.status(502).json({ error: "Unable to fetch layer tile" });
  }
});

router.get("/api/tiles/:style/:z/:x/:y.png", async (req, res) => {
  // Express/path-to-regexp matches the literal ".png" suffix in the route
  // pattern itself, so req.params.y is already just the numeric part.
  const { style, z, x, y } = req.params;
  const boundary = req.query.boundary ? String(req.query.boundary) : null;

  if (!STYLES[style]) {
    return res.status(400).json({ error: "Unknown basemap style" });
  }
  if (boundary && !isKnownGeoserverLayer(boundary)) {
    return res.status(400).json({ error: "Unknown boundary" });
  }

  try {
    const buffer = boundary
      ? await getMaskedTile(style, boundary, z, x, y)
      : await getRawTileBuffer(style, z, x, y);
    res.set("Cache-Control", "public, max-age=2592000, immutable"); // 30 days
    res.type("png");
    return res.send(buffer);
  } catch (err) {
    console.error(
      "Tile proxy error:",
      `${style}/${z}/${x}/${y}`,
      boundary || "",
      err.message
    );
    return res.status(502).json({ error: "Unable to fetch tile" });
  }
});

// ---------------------------------------------------------------------
// Automatic eviction sweep — hourly, fully async, off the request path.
// Prunes least-recently-served tiles (by mtime) once the cache exceeds
// CACHE_CAP_BYTES, back down to CACHE_PRUNE_TARGET_BYTES.
// ---------------------------------------------------------------------
async function walkFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export async function runCacheEvictionSweep() {
  try {
    const files = await walkFiles(CACHE_ROOT);
    if (!files.length) return;

    const stats = await Promise.all(
      files.map(async (f) => {
        try {
          const s = await fs.promises.stat(f);
          return { file: f, size: s.size, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const valid = stats.filter(Boolean);
    const totalSize = valid.reduce((sum, s) => sum + s.size, 0);

    if (totalSize <= CACHE_CAP_BYTES) return;

    // Oldest (least-recently-served) first.
    valid.sort((a, b) => a.mtime - b.mtime);

    let remaining = totalSize;
    for (const s of valid) {
      if (remaining <= CACHE_PRUNE_TARGET_BYTES) break;
      try {
        await fs.promises.unlink(s.file);
        remaining -= s.size;
      } catch {
        // ignore — file may have been removed/replaced concurrently
      }
    }
    console.log(
      `Tile cache eviction: pruned to ~${(remaining / 1024 / 1024 / 1024).toFixed(2)}GB`
    );
  } catch (err) {
    console.error("Tile cache eviction sweep failed:", err.message);
  }
}

export function startTileCacheEvictionSchedule() {
  setInterval(runCacheEvictionSweep, EVICTION_SWEEP_INTERVAL_MS);
}

// Exported for server/src/services/cacheWarmer.js — pre-warming reuses
// these exact functions (same disk cache, same concurrency limiters, same
// TTL/staleness rules) rather than re-implementing tile fetching, so a
// warmed tile and a normal request-triggered tile are byte-identical and
// share the same cache entry.
export {
  STYLES,
  getMaskedTile,
  getGwcTileBuffer,
  fetchBoundaryRings,
  tileBounds3857,
  bboxIntersects,
  MERCATOR_ORIGIN,
};

export default router;
