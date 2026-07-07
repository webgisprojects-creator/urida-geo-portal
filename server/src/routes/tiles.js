import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import crypto from "crypto";
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
//
// verifyToken is applied per-route below, NOT as a blanket `router.use()`.
// This router is mounted at the app root with no path prefix
// (`app.use(tileRoutes)` in app.js) — a blanket `router.use(verifyToken)`
// here runs for *every* request that reaches this router, not just the
// two routes actually defined below, which broke the bare `/` page-shell
// request and would have also gated telemetry.js's deliberately-public
// endpoint (confirmed live, same bug found in chainage.js and wfsCache.js).

// Disk cache root — one subdirectory per basemap style, mirroring the
// z/x/y tile pyramid. Gitignored; grows/shrinks at runtime.
const CACHE_ROOT = path.join(__dirname, "..", "..", "tile-cache");

// Cap + safety margin for the automatic eviction sweep. Kept well under a
// typical small VPS's free disk, and "smart managed" per the requirement
// that this must never slow the app down — the sweep runs on a timer, off
// the request path, so serving tiles is never blocked by it.
// TILE_CACHE_CAP_GB overrides the default 5GB — needed when the warmer's
// zoom ranges are raised (TILE_WARM_CITY_MAX_ZOOM etc., see cacheWarmer.js)
// for a full staging warm-up, where a deeper pass can legitimately exceed
// 5GB; without raising this in step, the hourly eviction sweep would evict
// tiles the warmer just fetched.
const CACHE_CAP_GB = Number(process.env.TILE_CACHE_CAP_GB) > 0
  ? Number(process.env.TILE_CACHE_CAP_GB)
  : 5;
const CACHE_CAP_BYTES = CACHE_CAP_GB * 1024 * 1024 * 1024;
const CACHE_PRUNE_TARGET_BYTES = Math.floor(CACHE_CAP_BYTES * 0.8); // prune back to 80% of cap
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
// `signal`: optional externally-owned AbortSignal (see getRawTileBuffer/
// getGwcTileBuffer's `req` param) — lets a route handler cancel this
// specific upstream fetch when the client that asked for it has already
// disconnected (e.g. zoomed again before this tile arrived), instead of
// the fetch running to completion for nobody. Same fix already confirmed
// live for wfsCache.js's WFS fetches.
function fetchViaHttp(url, timeoutMs, signal) {
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
    if (signal) {
      if (signal.aborted) req.destroy(new Error("Aborted before start"));
      else signal.addEventListener("abort", () => req.destroy(new Error("Client disconnected")), { once: true });
    }
  });
}

// Distinguishes the two failure stories the frontend tells the user when a
// basemap won't load: "network" — we never reached the provider at all
// (connection refused/reset, DNS failure, timeout: the signature of the
// deployment network firewalling the CDN, e.g. the UPSDC environment) vs
// "provider" — the CDN answered but with an error status (their outage,
// not our network's doing). Defaults to "provider" for anything
// unrecognized, since "contact the network team" is the more expensive
// wrong answer.
function classifyUpstreamFailure(err) {
  const code = String(err?.code || "");
  if (
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(code)
  ) {
    return "network";
  }
  const message = String(err?.message || "").toLowerCase();
  if (message.includes("timed out") || message.includes("socket hang up")) return "network";
  return "provider";
}

function isTransientUpstreamError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("fetch failed") ||
    /\b(502|503|504)\b/.test(message)
  );
}

async function runWithOneTransientRetry(operation, { label, signal } = {}) {
  let attempt = 0;
  let lastError;
  while (attempt < 2) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (signal?.aborted || !isTransientUpstreamError(err) || attempt >= 1) {
        throw err;
      }
      attempt += 1;
      console.warn(`[retry] ${label} transient failure, retrying once: ${err.message}`);
    }
  }
  throw lastError;
}

// Shared by getRawTileBuffer/getGwcTileBuffer: registers the calling HTTP
// request against an in-flight cache entry's refcount, and cancels the
// entry's shared AbortController once *every* request waiting on it has
// disconnected (not the first one — several users/tabs can legitimately
// share one in-flight fetch via the cache-key dedup above). No-op when
// `req` isn't provided (cacheWarmer.js's background warming, the
// neighbor-tile prefetch below — neither has a real client to track).
function trackAbortableClient(entry, req) {
  if (!req) return;
  entry.refCount += 1;
  let decremented = false;
  const decrementOnce = () => {
    if (decremented) return;
    decremented = true;
    entry.refCount -= 1;
    // Aborting after the fetch already finished normally is a harmless
    // no-op (Node's req.destroy() on a completed request is safe) — only
    // matters when this fires because the client left early.
    if (entry.refCount <= 0) entry.controller.abort();
  };
  req.on("close", decrementOnce);
  entry.promise.finally(decrementOnce);
}

// ---------------------------------------------------------------------
// Air-gapped operation support. This deployment may get internet access
// only once per 6-12 months (a deliberate window opened by the network
// team); the rest of the time every upstream fetch fails. Two mechanisms
// keep the basemaps fully usable regardless:
//
// 1. Upstream circuit breaker — after several consecutive upstream
//    failures, stop attempting upstream fetches for a cooldown period.
//    Without this, every uncached-tile request in offline mode would hang
//    ~30s (mirrors x timeouts x retry) before falling back; with it, only
//    the first few requests pay that, then everything fails over
//    instantly. A single success closes the breaker immediately, so the
//    moment the internet window opens, normal fetching resumes.
//
// 2. Ancestor-tile fallback (getAncestorFallbackTile below) — when a tile
//    isn't cached and upstream is unreachable, serve the nearest cached
//    parent tile's matching quadrant upscaled to 256x256. Slightly softer
//    imagery instead of a blank hole in the map: since the warmer
//    guarantees full coverage up to its configured max zoom, *every*
//    deeper tile has a cached ancestor, so offline mode can never render
//    blank basemap tiles anywhere in the covered extent.
// ---------------------------------------------------------------------
const BREAKER_OPEN_AFTER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
let upstreamConsecutiveFailures = 0;
let upstreamDownUntil = 0;

function upstreamBreakerOpen() {
  return Date.now() < upstreamDownUntil;
}
function noteUpstreamSuccess() {
  upstreamConsecutiveFailures = 0;
  upstreamDownUntil = 0;
}
function noteUpstreamFailure() {
  upstreamConsecutiveFailures += 1;
  if (upstreamConsecutiveFailures >= BREAKER_OPEN_AFTER_FAILURES) {
    if (!upstreamBreakerOpen()) {
      console.warn(
        `[tiles] upstream unreachable (${upstreamConsecutiveFailures} consecutive failures) — ` +
        `serving from cache + ancestor fallback only for the next ${BREAKER_COOLDOWN_MS / 60000} minutes`
      );
    }
    upstreamDownUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

// Serves the requested tile's area from the nearest cached ancestor tile,
// upscaled. Walks up the pyramid (z-1, z-2, ...) until a cached tile
// exists, then crops the quadrant this tile occupies within it and resizes
// to a full 256x256. Capped at 8 levels up (a 1px source region) — beyond
// that there's nothing meaningful left to show, but with the warmer's
// guaranteed coverage the walk realistically ends within 1-4 levels.
// Deliberately NOT written to the tile cache: these are lossy derivatives,
// and persisting them would poison the "truth" cache/MBTiles archives with
// blurry fakes that would then mask the real tile after connectivity
// returns.
async function getAncestorFallbackTile(style, z, x, y) {
  for (let shift = 1; shift <= 8 && z - shift >= 0; shift += 1) {
    const pz = z - shift;
    const px = x >> shift;
    const py = y >> shift;
    const parentPath = tileCachePath(style, pz, px, py);
    const stat = await fs.promises.stat(parentPath).catch(() => null);
    if (!stat) continue;
    const size = 256 >> shift; // source pixels covering this tile inside the parent
    if (size < 1) break;
    const left = (x - (px << shift)) * size;
    const top = (y - (py << shift)) * size;
    try {
      const buffer = await fs.promises.readFile(parentPath);
      return await sharp(buffer)
        .extract({ left, top, width: size, height: size })
        .resize(256, 256)
        .png()
        .toBuffer();
    } catch (err) {
      // Corrupt/unreadable parent — keep walking up.
      console.warn(`[tiles] ancestor fallback failed at ${style}/${pz}/${px}/${py}: ${err.message}`);
    }
  }
  return null;
}

async function fetchAndCacheTile(style, z, x, y, priority = "normal", signal) {
  const mirrors = orderedMirrors(style, z, x, y);
  if (!mirrors.length) return null;

  const limit = priority === "low" ? basemapLimiter.low : basemapLimiter;
  let lastError = null;
  for (const template of mirrors) {
    const url = buildUrl(template, z, x, y);
    try {
      const buffer = await runWithOneTransientRetry(
        () => limit(() => fetchViaHttp(url, PER_MIRROR_TIMEOUT_MS, signal)),
        { label: `basemap ${style}/${z}/${x}/${y}`, signal }
      );

      const filePath = tileCachePath(style, z, x, y);
      await ensureDir(path.dirname(filePath));
      await fs.promises.writeFile(filePath, buffer);

      return buffer;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err; // don't try further mirrors — client's gone
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
// `meta`: optional mutable out-parameter (e.g. `{}`) that gets a `cacheHit`
// boolean set on it — lets the HTTP route handlers report `X-Cache: HIT/MISS`
// without changing this function's return value (buffer), so cacheWarmer.js
// and every other caller that doesn't pass `meta` is unaffected. This is
// what lets a load test distinguish "slow because it's a genuine cache
// miss doing real upstream work" from "slow even on a cache hit" (a real
// bug) instead of just seeing one opaque duration number.
// `req`: optional Express request — when provided, this specific caller's
// disconnect (client aborted, panned/zoomed again before this tile
// arrived) is tracked against the shared in-flight fetch, cancelling the
// actual upstream request once every waiting caller has left instead of
// letting it run to completion for nobody. Omitted by cacheWarmer.js and
// the neighbor-tile prefetch below, which have no real client to track.
async function getRawTileBuffer(style, z, x, y, priority = "normal", meta = null, req = null) {
  const filePath = tileCachePath(style, z, x, y);
  const cacheKey = `${style}/${z}/${x}/${y}`;

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat) {
    if (meta) meta.cacheHit = true;
    const now = new Date();
    fs.promises.utimes(filePath, now, now).catch(() => {});
    return fs.promises.readFile(filePath);
  }
  if (meta) meta.cacheHit = false;

  // Offline mode (breaker open): don't burn ~30s of mirror timeouts per
  // tile — go straight to the nearest cached ancestor. See the air-gapped
  // operation block above.
  if (upstreamBreakerOpen()) {
    const fallback = await getAncestorFallbackTile(style, z, x, y);
    if (fallback) {
      if (meta) meta.isFallback = true;
      return fallback;
    }
    throw new Error(`Upstream down and no cached ancestor for ${cacheKey}`);
  }

  let entry = inFlight.get(cacheKey);
  if (!entry) {
    const controller = new AbortController();
    const promise = fetchAndCacheTile(style, z, x, y, priority, controller.signal)
      .then(
        (buffer) => {
          noteUpstreamSuccess();
          return buffer;
        },
        (err) => {
          // A client walking away mid-fetch says nothing about upstream
          // health — only count real upstream failures toward the breaker.
          const message = String(err?.message || "");
          if (!message.includes("Client disconnected") && !message.includes("Aborted before start")) {
            noteUpstreamFailure();
          }
          throw err;
        }
      )
      .finally(() => {
        inFlight.delete(cacheKey);
      });
    entry = { promise, controller, refCount: 0 };
    inFlight.set(cacheKey, entry);
  }
  trackAbortableClient(entry, req);
  try {
    return await entry.promise;
  } catch (err) {
    // Upstream fetch genuinely failed — last line of defense before the
    // map shows a hole: upscale the nearest cached ancestor.
    const fallback = await getAncestorFallbackTile(style, z, x, y);
    if (fallback) {
      if (meta) meta.isFallback = true;
      return fallback;
    }
    throw err;
  }
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
// Must exceed GeoServer's own control-flow `timeout` (60s) - this call goes
// straight to GeoServer (not through Nginx), but is still subject to that
// same server-side queue.
const BOUNDARY_FETCH_TIMEOUT_MS = 70000;

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
  const buffer = await runWithOneTransientRetry(
    () => limit(() => fetchViaHttp(url, BOUNDARY_FETCH_TIMEOUT_MS)),
    { label: `boundary ${boundaryRaw}` }
  );
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

// Full 256x256 fully-transparent PNG — cheap short-circuit for tiles that
// don't intersect the boundary at all (no upstream fetch, no compositing).
// Was previously a 1x1 pixel stretched to tile size by the browser — that
// scaling of a single transparent-black pixel rendered as solid opaque
// black in real testing (confirmed: switching HomePage's basemap mask to
// a per-city boundary made this reproducible — a genuine, long-reported
// "black tiles" bug, not fixable by the client-side View background-color
// fallback alone since the tile itself loads "successfully"). A properly
// tile-sized transparent PNG needs no client-side scaling/interpolation of
// its alpha channel, so this class of artifact can't happen.
const TRANSPARENT_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABFUlEQVR4nO3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6AwBPAABo9vSmwAAAABJRU5ErkJggg==",
  "base64"
);

async function getMaskedTile(style, boundaryRaw, z, x, y, priority = "normal", meta = null, req = null) {
  const safeKey = safeBoundaryKey(boundaryRaw);
  const filePath = maskedTileCachePath(style, safeKey, z, x, y);

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat) {
    if (meta) meta.cacheHit = true;
    const now = new Date();
    fs.promises.utimes(filePath, now, now).catch(() => {});
    return fs.promises.readFile(filePath);
  }
  if (meta) meta.cacheHit = false;

  const { rings, bbox } = await fetchBoundaryRings(boundaryRaw, priority);
  const tileBBox = tileBounds3857(Number(z), Number(x), Number(y));

  if (!rings.length || !bboxIntersects(bbox, tileBBox)) {
    // Flagged separately so the route handler can give this a short cache
    // lifetime instead of the normal 30-day immutable one — this exact
    // response (a fixed, cheap-to-regenerate constant) is what silently
    // masked the "1x1 PNG scaled to black" bug for weeks: browsers that had
    // already cached the old broken bytes for a given tile URL had no way
    // to ever learn about the fix. A real map tile's pixels genuinely never
    // change and can be cached hard; whether a given tile falls outside a
    // boundary is comparatively cheap to get wrong once and expensive to
    // have every browser stay wrong about for a month.
    if (meta) meta.isTransparentFallback = true;
    return TRANSPARENT_TILE;
  }

  const rawMeta = {};
  const rawBuffer = await getRawTileBuffer(style, z, x, y, priority, rawMeta, req);
  const maskSvg = buildMaskSvg(rings, tileBBox);
  const maskBuffer = await sharp(Buffer.from(maskSvg)).png().toBuffer();
  const masked = await sharp(rawBuffer)
    .ensureAlpha()
    .composite([{ input: maskBuffer, blend: "dest-in" }])
    .png()
    .toBuffer();

  // A masked tile built from an ancestor-fallback source is a lossy stand-
  // in, not truth — serve it (short browser cache via meta.isFallback) but
  // never persist it, or the blurry version would permanently shadow the
  // real tile after connectivity returns.
  if (rawMeta.isFallback) {
    if (meta) meta.isFallback = true;
    return masked;
  }

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
// Must exceed both Nginx's proxy_cache_lock_timeout (60s,
// deploy/nginx/urida-lb2-geoserver-site.conf) and GeoServer's own
// control-flow `timeout` (60s, controlflow.properties) — otherwise this app
// gives up and reports a failure for a request that Nginx/GeoServer were
// still legitimately queuing and about to serve.
const GWC_FETCH_TIMEOUT_MS = 70000;

function safeGwcLayerKey(layerRaw) {
  return String(layerRaw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function gwcTileCachePath(layerRaw, z, x, y) {
  return path.join(CACHE_ROOT, "gwc", safeGwcLayerKey(layerRaw), String(z), String(x), `${y}.png`);
}

async function fetchAndCacheGwcTile(layerRaw, z, x, y, priority = "normal", signal) {
  const [minX, minY, maxX, maxY] = tileBounds3857(Number(z), Number(x), Number(y));
  const url =
    `${GEOSERVER_UPSTREAM_BASE}/gwc/service/wms?service=WMS&version=1.1.1&request=GetMap` +
    `&layers=${encodeURIComponent(layerRaw)}&bbox=${minX},${minY},${maxX},${maxY}` +
    `&width=256&height=256&srs=EPSG:3857&format=image/png&transparent=true&tiled=true`;
  const limit = priority === "low" ? geoserverLimiter.low : geoserverLimiter;
  const buffer = await runWithOneTransientRetry(
    () => limit(() => fetchViaHttp(url, GWC_FETCH_TIMEOUT_MS, signal)),
    { label: `gwc ${layerRaw}/${z}/${x}/${y}`, signal }
  );
  const filePath = gwcTileCachePath(layerRaw, z, x, y);
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, buffer);
  return buffer;
}

// GWC only ever serves its own pre-seeded, unparameterized tile grid — it
// has no way to apply an ad-hoc CQL_FILTER, so any filtered request (every
// field-task view: the whole point is a permanent zone/ward CQL_FILTER
// baked in for the session) has always had to bypass GWC and hit
// GeoServer's regular WMS GetMap renderer directly, with zero caching
// anywhere, client or server. Confirmed live: dozens of these per page load,
// each taking 4-9s against this environment's GeoServer — the single
// largest source of "stuck loading" in real testing, and it hit hardest
// exactly where it matters most, since a field-task session's Road Network
// layer is *always* filtered. A given field-task filter is stable for an
// entire session (a KMC worker's assigned zone/ward doesn't change
// mid-shift) and often shared across everyone assigned to the same ward, so
// it's genuinely cacheable — just keyed by filter+style in addition to
// layer/z/x/y, the same shape as wfsCache.js's existing CQL-aware cache for
// this same layer's WFS click-detail data.
const FILTERED_WMS_TTL_MS = 60 * 60 * 1000; // 1 hour, same lifetime as GWC's own layer cache
// See GWC_FETCH_TIMEOUT_MS above - must exceed Nginx's and GeoServer's own
// 60s timeouts in the same request chain.
const FILTERED_WMS_FETCH_TIMEOUT_MS = 70000;

function getWorkspaceFromLayerName(layerName, fallback = "") {
  if (typeof layerName === "string" && layerName.includes(":")) {
    return layerName.split(":")[0];
  }
  return fallback;
}

function filteredWmsVariantHash(cqlFilter, styles) {
  const normalized = JSON.stringify({ cqlFilter: cqlFilter || "", styles: styles || "" });
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function filteredWmsCachePath(layerRaw, cqlFilter, styles, z, x, y) {
  const hash = filteredWmsVariantHash(cqlFilter, styles);
  return path.join(CACHE_ROOT, "wms-filtered", safeGwcLayerKey(layerRaw), hash, String(z), String(x), `${y}.png`);
}

async function fetchAndCacheFilteredWmsTile(layerRaw, cqlFilter, styles, z, x, y, priority, signal) {
  const [minX, minY, maxX, maxY] = tileBounds3857(Number(z), Number(x), Number(y));
  const workspace = getWorkspaceFromLayerName(layerRaw);
  const base = workspace ? `${GEOSERVER_UPSTREAM_BASE}/${workspace}/wms` : `${GEOSERVER_UPSTREAM_BASE}/wms`;
  const url =
    `${base}?service=WMS&version=1.1.1&request=GetMap` +
    `&layers=${encodeURIComponent(layerRaw)}&bbox=${minX},${minY},${maxX},${maxY}` +
    `&width=256&height=256&srs=EPSG:3857&format=image/png&transparent=true&tiled=true` +
    (styles ? `&styles=${encodeURIComponent(styles)}` : "") +
    (cqlFilter ? `&CQL_FILTER=${encodeURIComponent(cqlFilter)}` : "");
  const limit = priority === "low" ? geoserverLimiter.low : geoserverLimiter;
  const buffer = await runWithOneTransientRetry(
    () => limit(() => fetchViaHttp(url, FILTERED_WMS_FETCH_TIMEOUT_MS, signal)),
    { label: `wms ${layerRaw}/${z}/${x}/${y}`, signal }
  );
  const filePath = filteredWmsCachePath(layerRaw, cqlFilter, styles, z, x, y);
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, buffer);
  return buffer;
}

async function getFilteredWmsTileBuffer(layerRaw, cqlFilter, styles, z, x, y, priority = "normal", meta = null, req = null) {
  const filePath = filteredWmsCachePath(layerRaw, cqlFilter, styles, z, x, y);
  const cacheKey = `wms-filtered/${safeGwcLayerKey(layerRaw)}/${filteredWmsVariantHash(cqlFilter, styles)}/${z}/${x}/${y}`;

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs < FILTERED_WMS_TTL_MS) {
    if (meta) meta.cacheHit = true;
    return fs.promises.readFile(filePath);
  }
  if (meta) meta.cacheHit = false;

  let entry = inFlight.get(cacheKey);
  if (!entry) {
    const controller = new AbortController();
    const promise = fetchAndCacheFilteredWmsTile(layerRaw, cqlFilter, styles, z, x, y, priority, controller.signal).finally(() => {
      inFlight.delete(cacheKey);
    });
    entry = { promise, controller, refCount: 0 };
    inFlight.set(cacheKey, entry);
  }
  trackAbortableClient(entry, req);
  try {
    return await entry.promise;
  } catch (err) {
    if (stat) {
      if (meta) meta.cacheHit = "stale";
      return fs.promises.readFile(filePath);
    }
    throw err;
  }
}

async function getGwcTileBuffer(layerRaw, z, x, y, priority = "normal", meta = null, req = null) {
  const filePath = gwcTileCachePath(layerRaw, z, x, y);
  const cacheKey = `gwc/${safeGwcLayerKey(layerRaw)}/${z}/${x}/${y}`;

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs < GWC_TILE_TTL_MS) {
    if (meta) meta.cacheHit = true;
    return fs.promises.readFile(filePath);
  }
  if (meta) meta.cacheHit = false;

  let entry = inFlight.get(cacheKey);
  if (!entry) {
    const controller = new AbortController();
    const promise = fetchAndCacheGwcTile(layerRaw, z, x, y, priority, controller.signal).finally(() => {
      inFlight.delete(cacheKey);
    });
    entry = { promise, controller, refCount: 0 };
    inFlight.set(cacheKey, entry);
  }
  trackAbortableClient(entry, req);
  try {
    return await entry.promise;
  } catch (err) {
    if (stat) {
      if (meta) meta.cacheHit = "stale"; // upstream failed, served a TTL-expired cached copy
      return fs.promises.readFile(filePath); // serve stale over nothing
    }
    throw err;
  }
}

// The background cache-warmer (server/src/services/cacheWarmer.js) only
// covers zoom 11-16 — going deeper for every city would be combinatorially
// unaffordable (each zoom level is ~4x the tile count of the one above;
// z20 would be ~4^4 = 256x z16's already-546s-per-level cost, and blow
// well past the 5GB disk cap warming areas nobody's looking at). Real
// users reported "still loading" at exactly this deeper-than-16 zoom —
// confirmed the warmer simply never reaches there.
//
// Fix: reactive neighbor prefetch. When a real request is a genuine cache
// MISS (the interesting case — a HIT means this area's probably already
// warm), fire off the 8 neighboring tiles at the same zoom in the
// background at low priority, fire-and-forget. This warms the area a user
// is *actually* looking at, scaling with real usage instead of trying to
// precompute every possible location upfront — the next pan in any
// direction from here is now likely already cached.
function prefetchNeighborTiles(fetchOne, z, x, y) {
  const zNum = Number(z);
  const xNum = Number(x);
  const yNum = Number(y);
  const maxIndex = 2 ** zNum - 1;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = xNum + dx;
      const ny = yNum + dy;
      if (nx < 0 || nx > maxIndex || ny < 0 || ny > maxIndex) continue;
      fetchOne(nx, ny).catch(() => {}); // best-effort, never surfaced to any user
    }
  }
}

router.get("/api/gwc-tiles/:layerPath/:z/:x/:y.png", verifyToken, async (req, res) => {
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
  const meta = {};
  try {
    const buffer = await getGwcTileBuffer(layerPath, z, x, y, "normal", meta, req);
    // Much shorter than basemap tiles — this is real, editable GIS data,
    // not eternal imagery.
    res.set("Cache-Control", "public, max-age=300");
    res.set("X-Cache", meta.cacheHit === true ? "HIT" : meta.cacheHit === "stale" ? "STALE" : "MISS");
    res.type("png");
    res.send(buffer);
    if (meta.cacheHit === false) {
      prefetchNeighborTiles((nx, ny) => getGwcTileBuffer(layerPath, z, nx, ny, "low"), z, x, y);
    }
    return;
  } catch (err) {
    console.error("GWC tile proxy error:", layerPath, `${z}/${x}/${y}`, err.message);
    return res.status(502).json({ error: "Unable to fetch layer tile" });
  }
});

// Cached counterpart to the plain GWC route above, for the one case GWC
// itself can't serve: a layer with a live CQL_FILTER (every field-task
// zone/ward-scoped view). Same disk-cache/in-flight-dedup shape, just keyed
// by filter+style as well as layer/z/x/y, and fetching from GeoServer's
// regular WMS renderer instead of GWC's pre-tiled endpoint.
router.get("/api/wms-tile-cache/:layerPath/:z/:x/:y.png", verifyToken, async (req, res) => {
  const { layerPath, z, x, y } = req.params;
  const cqlFilter = req.query.cqlFilter ? String(req.query.cqlFilter) : "";
  const styles = req.query.styles ? String(req.query.styles) : "";
  if (!layerPath) {
    return res.status(400).json({ error: "Missing layer" });
  }
  if (!isKnownGeoserverLayer(layerPath)) {
    return res.status(400).json({ error: "Unknown layer" });
  }
  const meta = {};
  try {
    const buffer = await getFilteredWmsTileBuffer(layerPath, cqlFilter, styles, z, x, y, "normal", meta, req);
    res.set("Cache-Control", "public, max-age=300");
    res.set("X-Cache", meta.cacheHit === true ? "HIT" : meta.cacheHit === "stale" ? "STALE" : "MISS");
    res.type("png");
    res.send(buffer);
    if (meta.cacheHit === false) {
      prefetchNeighborTiles(
        (nx, ny) => getFilteredWmsTileBuffer(layerPath, cqlFilter, styles, z, nx, ny, "low"),
        z,
        x,
        y
      );
    }
    return;
  } catch (err) {
    console.error("Filtered WMS tile proxy error:", layerPath, `${z}/${x}/${y}`, err.message);
    return res.status(502).json({ error: "Unable to fetch layer tile" });
  }
});

router.get("/api/tiles/:style/:z/:x/:y.png", verifyToken, async (req, res) => {
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

  const meta = {};
  try {
    const buffer = boundary
      ? await getMaskedTile(style, boundary, z, x, y, "normal", meta, req)
      : await getRawTileBuffer(style, z, x, y, "normal", meta, req);
    res.set(
      "Cache-Control",
      meta.isFallback
        ? "public, max-age=300" // 5 min — upscaled stand-in; let the real tile replace it fast
        : meta.isTransparentFallback
          ? "public, max-age=3600" // 1 hour — see getMaskedTile's comment
          : "public, max-age=2592000, immutable" // 30 days
    );
    res.set("X-Cache", meta.isFallback ? "FALLBACK" : meta.cacheHit ? "HIT" : "MISS");
    res.type("png");
    res.send(buffer);
    if (!meta.cacheHit) {
      prefetchNeighborTiles(
        (nx, ny) =>
          boundary
            ? getMaskedTile(style, boundary, z, nx, ny, "low")
            : getRawTileBuffer(style, z, nx, ny, "low"),
        z,
        x,
        y
      );
    }
    return;
  } catch (err) {
    console.error(
      "Tile proxy error:",
      `${style}/${z}/${x}/${y}`,
      boundary || "",
      err.message
    );
    // `reason` lets the client tell the user the right story: "network"
    // (this deployment's network is blocking the provider — contact the
    // network team) vs "provider" (the CDN itself is having trouble — try
    // another basemap). See classifyUpstreamFailure above.
    return res.status(502).json({ error: "Unable to fetch tile", reason: classifyUpstreamFailure(err) });
  }
});

// ---------------------------------------------------------------------
// Boundary GeoJSON (zone/ward/etc.) — full features with attributes, for
// layers that used to be rendered server-side via a per-request dynamic
// SLD_BODY (uncacheable by construction: GWC/WMS caches are keyed on the
// request's parameters, and a unique style string on every request means
// a unique — and therefore never-reused — cache entry every time). These
// boundary sets are small and change essentially never, so instead:
// fetch the raw geometry once per city (cached here, same TTL/on-disk
// pattern as fetchBoundaryRings above), style and label it in the browser
// with OpenLayers. GeoWebCache/GeoServer still does all the heavy lifting
// for every layer that has a fixed, reusable style (Road Network tiles,
// basemaps) — this only routes around the one pattern no server-side tile
// cache can ever help with.
// ---------------------------------------------------------------------
const boundaryGeoJsonMemoryCache = new Map(); // safeKey -> { geojson, fetchedAt }

async function fetchBoundaryGeoJson(layerName, priority = "normal") {
  const safeKey = safeBoundaryKey(layerName) + "_full";
  const cached = boundaryGeoJsonMemoryCache.get(safeKey);
  if (cached && Date.now() - cached.fetchedAt < BOUNDARY_TTL_MS) return cached.geojson;

  const diskPath = path.join(BOUNDARY_CACHE_ROOT, `${safeKey}.json`);
  try {
    const stat = await fs.promises.stat(diskPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < BOUNDARY_TTL_MS) {
      const geojson = JSON.parse(await fs.promises.readFile(diskPath, "utf-8"));
      boundaryGeoJsonMemoryCache.set(safeKey, { geojson, fetchedAt: stat.mtimeMs });
      return geojson;
    }
  } catch {
    // fall through to a fresh fetch
  }

  const url =
    `${GEOSERVER_UPSTREAM_BASE}/wfs?service=WFS&version=1.1.0&request=GetFeature` +
    `&typeName=${encodeURIComponent(layerName)}&outputFormat=application/json` +
    `&srsName=EPSG:3857`;
  const limit = priority === "low" ? geoserverLimiter.low : geoserverLimiter;
  const buffer = await limit(() => fetchViaHttp(url, BOUNDARY_FETCH_TIMEOUT_MS));
  const geojson = JSON.parse(buffer.toString("utf-8"));

  boundaryGeoJsonMemoryCache.set(safeKey, { geojson, fetchedAt: Date.now() });
  await ensureDir(BOUNDARY_CACHE_ROOT);
  fs.promises.writeFile(diskPath, JSON.stringify(geojson)).catch(() => {});
  return geojson;
}

router.get("/api/boundary-geojson/:workspace/:layer", verifyToken, async (req, res) => {
  const { workspace, layer } = req.params;
  const layerName = `${workspace}:${layer}`;
  if (!isKnownGeoserverLayer(layerName)) {
    return res.status(400).json({ error: "Unknown layer" });
  }
  try {
    const geojson = await fetchBoundaryGeoJson(layerName);
    res.set("Cache-Control", "public, max-age=3600");
    res.json(geojson);
  } catch (err) {
    console.error("Boundary GeoJSON fetch error:", layerName, err.message);
    res.status(502).json({ error: "Unable to fetch boundary features" });
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
// Cheap "is the internet window open right now?" check for the
// cache-warmer's auto-resume loop: one real upstream fetch (bypassing the
// disk cache AND the circuit breaker — this is the probe that discovers
// the breaker can close). ~30s worst case offline (mirror rotation +
// timeouts), instant online.
async function probeUpstreamConnectivity() {
  try {
    await fetchAndCacheTile("osm", 6, 45, 27, "low");
    noteUpstreamSuccess();
    return true;
  } catch {
    return false;
  }
}

export {
  STYLES,
  getMaskedTile,
  getRawTileBuffer,
  getGwcTileBuffer,
  fetchBoundaryRings,
  tileBounds3857,
  bboxIntersects,
  MERCATOR_ORIGIN,
  probeUpstreamConnectivity,
};

export default router;
