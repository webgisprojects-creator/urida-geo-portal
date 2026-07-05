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
// <Protected> login gate, so this is transparent to real users.
router.use(verifyToken);

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
const FETCH_TIMEOUT_MS = 15000;

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

router.get("/api/road-wfs-cache", async (req, res) => {
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

  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      res.set("Cache-Control", "public, max-age=60");
      res.type("application/json");
      return res.sendFile(filePath);
    }

    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const crs = srsName || "EPSG:3857";
        // The bbox param MUST carry its own CRS suffix (5th comma-separated
        // value) — without it GeoServer interprets the raw coordinates
        // against the layer's native CRS instead of `srsName`, which for a
        // Web Mercator bbox against a non-Mercator-native layer silently
        // matches zero features instead of erroring. Confirmed directly:
        // identical request with/without the suffix returned 0 vs. real
        // road geometry.
        const url =
          `${GEOSERVER_UPSTREAM_BASE}/wfs?service=WFS&version=1.1.0&request=GetFeature` +
          `&typeName=${encodeURIComponent(layer)}` +
          `&outputFormat=application/json` +
          `&srsName=${encodeURIComponent(crs)}` +
          `&bbox=${encodeURIComponent(`${bbox},${crs}`)}` +
          (maxFeatures ? `&maxFeatures=${encodeURIComponent(maxFeatures)}` : "") +
          (cqlFilter ? `&CQL_FILTER=${encodeURIComponent(cqlFilter)}` : "");

        return geoserverLimiter(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          try {
            const upstreamRes = await fetch(url, { signal: controller.signal });
            if (!upstreamRes.ok) {
              throw new Error(`Upstream WFS fetch failed: ${upstreamRes.status}`);
            }
            const body = await upstreamRes.text();
            await ensureDir(CACHE_ROOT);
            await fs.promises.writeFile(filePath, body);
            return body;
          } finally {
            clearTimeout(timeout);
          }
        });
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }

    const body = await pending;
    res.set("Cache-Control", "public, max-age=60");
    res.type("application/json");
    return res.send(body);
  } catch (err) {
    // Graceful degradation: serve a stale cached copy over a hard failure
    // if we have one, same principle as the GWC tile cache.
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat) {
      res.set("Cache-Control", "public, max-age=60");
      res.type("application/json");
      return res.sendFile(filePath);
    }
    console.error("Road WFS cache error:", err.message);
    return res.status(502).json({ error: "Unable to fetch road detail data" });
  }
});

export default router;
