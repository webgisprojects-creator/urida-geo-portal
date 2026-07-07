import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { geoserverLimiter } from "../utils/concurrencyLimiter.js";
import { verifyToken } from "../middleware/authMiddleware.js";
import { isKnownGeoserverLayer } from "../utils/knownGeoserverLayers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Same reasoning as tiles.js: every consumer is already behind the client's
// <Protected> login gate, so this is transparent to real users. Applied
// per-route below, not as a blanket `router.use()` — this router is
// mounted at the app root with no path prefix, so a blanket call here runs
// for every request that reaches it, not just the one route below (same
// bug found and fixed in chainage.js/tiles.js).

// Caches WFS GetFeature responses that are expensive/frequent but change
// rarely — right now specifically the road-network "detail" layer used
// client-side for precise click hit-testing (client/src/components/
// MapContainer.jsx's roadWfsLayer), which was previously fetched straight
// from GeoServer on every pan/zoom with zero caching. Confirmed via a real
// test session's telemetry: this single call accounted for the largest,
// slowest bucket of network traffic in the whole app.
//
// Deliberately conservative: this changes *where* the request goes, not
// *what* it asks for — the client still builds the exact same bbox/filter
// query it always did, just against this cache instead of GeoServer
// directly. No tile-grid snapping, no bbox rewriting — smaller, safer
// change, at the cost of a lower cache-hit rate than true grid-based tile
// caching would give.
const CACHE_ROOT = path.join(__dirname, "..", "..", "wfs-cache");
const GEOSERVER_UPSTREAM_BASE = (
  process.env.GEOSERVER_PROXY_TARGET || "http://localhost:8080/geoserver"
).replace(/\/$/, "");
// Short TTL — this is real road data, and the client's own extent-based
// dedup already avoids re-requesting an unchanged view, so this cache
// mainly helps repeat/overlapping views across different users and quick
// back-and-forth panning, not long-term staleness.
const CACHE_TTL_MS = 3 * 60 * 1000;
// Must exceed both Nginx's proxy_cache_lock_timeout and GeoServer's own
// control-flow `timeout` (both 60s) - otherwise this app gives up and
// reports a failure for a request Nginx/GeoServer were still legitimately
// queuing and about to serve (see tiles.js's GWC_FETCH_TIMEOUT_MS).
const FETCH_TIMEOUT_MS = 70000;

// Unlike tiles.js's grid-snapped tile cache (high reuse — many users pan
// through the same z/x/y), this cache is keyed by an *exact* floating-point
// bbox, so once a bbox goes stale it's very unlikely anyone requests that
// precise bbox again — the TTL above only controls whether a file gets
// *served*, nothing ever deleted the file itself. Left unmanaged, this
// directory grows without bound as users pan around (every slightly
// different bbox is a new cache key, forever). Prune aggressively by age
// (well past the point of any realistic reuse) with a size cap as a
// backstop, same shape as tiles.js's eviction sweep for consistency.
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const CACHE_PRUNE_TARGET_BYTES = 1.5 * 1024 * 1024 * 1024;
const EVICTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const inFlight = new Map();

function cacheKeyFor(query) {
  const normalized = JSON.stringify({
    layer: query.layer || "",
    bbox: query.bbox || "",
    srsName: query.srsName || "",
    maxFeatures: query.maxFeatures || "",
    cqlFilter: query.cqlFilter || "",
  });
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
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

router.get("/api/road-wfs-cache", verifyToken, async (req, res) => {
  const { layer, bbox, srsName, maxFeatures, cqlFilter } = req.query;
  if (!layer || !bbox) {
    return res.status(400).json({ error: "layer and bbox are required" });
  }
  // Same reasoning as tiles.js's boundary/layerPath checks: layer is used
  // directly as the WFS typeName sent to GeoServer.
  if (!isKnownGeoserverLayer(layer)) {
    return res.status(400).json({ error: "Unknown layer" });
  }

  const key = cacheKeyFor(req.query);
  const filePath = path.join(CACHE_ROOT, `${key}.json`);
  // Declared outside the try/catch (not inside `try`) so the catch block
  // below can also see and set it — `let`/`const` inside `try {}` is
  // scoped to that block only, not visible from a sibling `catch {}`.
  let settled = false;
  let claimedEntry = null;

  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      res.set("Cache-Control", "public, max-age=60");
      res.set("X-Cache", "HIT");
      res.type("application/json");
      return res.sendFile(filePath);
    }

    let entry = inFlight.get(key);
    if (!entry) {
      // Every continuous pan/zoom produces a slightly different bbox, so
      // these almost never share a cache key — meaning a client that pans
      // again before the previous fetch finishes used to leave that fetch
      // running on the server *forever*, still holding a geoserverLimiter
      // slot, even though the browser had already given up and moved on.
      // Confirmed directly from real audit-log traffic: dozens of these
      // stacking up during continuous panning, each taking 2-6s, explaining
      // a "loading" banner that never seems to clear. Fixed by giving each
      // in-flight fetch its own AbortController and a live client count —
      // only actually cancels the upstream GeoServer request once *every*
      // client waiting on it has disconnected, not on the first one.
      const controller = new AbortController();
      const promise = (async () => {
        const crs = srsName || "EPSG:3857";
        // The bbox param MUST carry its own CRS suffix (5th comma-separated
        // value) — without it GeoServer interprets the raw coordinates
        // against the layer's native CRS instead of `srsName`, which for a
        // Web Mercator bbox against a non-Mercator-native layer silently
        // matches zero features instead of erroring. Confirmed directly:
        // identical request with/without the suffix returned 0 vs. real
        // road geometry.
        //
        // GeoServer's WFS rejects a request that specifies bbox= and
        // cql_filter= as separate parameters at the same time
        // ("bbox and cql_filter both specified but are mutually
        // exclusive") — confirmed live: every field-task/ward-scoped view
        // (i.e. every request that has a real cqlFilter) was silently
        // failing on this every single time, always falling back to the
        // "Road network detail could not be loaded" notice. When a filter
        // is present, fold the bbox into it as a CQL BBOX() predicate
        // instead of sending both as separate top-level params.
        let bboxParam = "";
        let filterParam = "";
        if (cqlFilter) {
          const [minX, minY, maxX, maxY] = String(bbox).split(",").map(Number);
          const bboxPredicate = `BBOX(geom,${minX},${minY},${maxX},${maxY},'${crs}')`;
          filterParam = `&CQL_FILTER=${encodeURIComponent(`(${cqlFilter}) AND ${bboxPredicate}`)}`;
        } else {
          bboxParam = `&bbox=${encodeURIComponent(`${bbox},${crs}`)}`;
        }
        const url =
          `${GEOSERVER_UPSTREAM_BASE}/wfs?service=WFS&version=1.1.0&request=GetFeature` +
          `&typeName=${encodeURIComponent(layer)}` +
          `&outputFormat=application/json` +
          `&srsName=${encodeURIComponent(crs)}` +
          bboxParam +
          (maxFeatures ? `&maxFeatures=${encodeURIComponent(maxFeatures)}` : "") +
          filterParam;

        return geoserverLimiter(async () => {
          const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          try {
            const body = await runWithOneTransientRetry(
              async () => {
                const upstreamRes = await fetch(url, { signal: controller.signal });
                if (!upstreamRes.ok) {
                  throw new Error(`Upstream WFS fetch failed: ${upstreamRes.status}`);
                }
                const text = await upstreamRes.text();
                // GeoServer's own WFS exception reports come back as HTTP 200
                // with an XML ows:ExceptionReport body (confirmed live: the
                // bbox/cql_filter conflict this route used to trigger on every
                // filtered request did exactly this) - upstreamRes.ok alone
                // can't catch that class of failure. Never cache/serve an XML
                // body labeled as this route's JSON.
                if (/^\s*<\?xml|^\s*<ows:ExceptionReport/i.test(text)) {
                  throw new Error(`Upstream WFS returned an exception report: ${text.slice(0, 300)}`);
                }
                return text;
              },
              { label: `wfs ${layer}/${req.query.bbox || "bbox"}`, signal: controller.signal }
            );
            await ensureDir(CACHE_ROOT);
            await fs.promises.writeFile(filePath, body);
            return body;
          } finally {
            clearTimeout(timeout);
          }
        });
      })().finally(() => inFlight.delete(key));
      entry = { promise, controller, refCount: 0 };
      inFlight.set(key, entry);
    }

    entry.refCount += 1;
    claimedEntry = entry;
    const onClientDisconnect = () => {
      if (settled) return; // response already sent normally, not a real abort
      entry.refCount -= 1;
      if (entry.refCount <= 0) entry.controller.abort();
    };
    req.on("close", onClientDisconnect);

    const body = await entry.promise;
    settled = true;
    entry.refCount -= 1;
    res.set("Cache-Control", "public, max-age=60");
    res.set("X-Cache", "MISS");
    res.type("application/json");
    return res.send(body);
  } catch (err) {
    settled = true;
    if (claimedEntry) claimedEntry.refCount -= 1;
    // Graceful degradation: serve a stale cached copy over a hard failure
    // if we have one, same principle as the GWC tile cache.
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat) {
      res.set("Cache-Control", "public, max-age=60");
      res.set("X-Cache", "STALE");
      res.type("application/json");
      return res.sendFile(filePath);
    }
    console.error("Road WFS cache error:", err.message);
    return res.status(502).json({ error: "Unable to fetch road detail data" });
  }
});

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
    if (entry.isDirectory()) results.push(...(await walkFiles(full)));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

export async function runWfsCacheEvictionSweep() {
  try {
    const files = await walkFiles(CACHE_ROOT);
    if (!files.length) return;

    const now = Date.now();
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
    let valid = stats.filter(Boolean);

    // Pass 1: delete anything past the point of any realistic reuse,
    // regardless of total size.
    const aged = valid.filter((s) => now - s.mtime > CACHE_MAX_AGE_MS);
    for (const s of aged) {
      try {
        await fs.promises.unlink(s.file);
      } catch {
        // ignore — may have been removed/replaced concurrently
      }
    }
    valid = valid.filter((s) => now - s.mtime <= CACHE_MAX_AGE_MS);

    // Pass 2: size cap as a backstop, oldest first, in case age-based
    // pruning alone can't keep up with request volume.
    const totalSize = valid.reduce((sum, s) => sum + s.size, 0);
    if (totalSize <= CACHE_CAP_BYTES) {
      if (aged.length) console.log(`WFS cache eviction: pruned ${aged.length} aged entries`);
      return;
    }
    valid.sort((a, b) => a.mtime - b.mtime);
    let remaining = totalSize;
    for (const s of valid) {
      if (remaining <= CACHE_PRUNE_TARGET_BYTES) break;
      try {
        await fs.promises.unlink(s.file);
        remaining -= s.size;
      } catch {
        // ignore
      }
    }
    console.log(
      `WFS cache eviction: pruned ${aged.length} aged entries, size-capped to ~${(remaining / 1024 / 1024).toFixed(0)}MB`
    );
  } catch (err) {
    console.error("WFS cache eviction sweep failed:", err.message);
  }
}

export function startWfsCacheEvictionSchedule() {
  setInterval(runWfsCacheEvictionSweep, EVICTION_SWEEP_INTERVAL_MS);
}

export default router;
