#!/usr/bin/env node
// Simulates N concurrent real users browsing the Dashboard against a
// running server (default: localhost:8060) and reports detailed latency/
// error/cache-hit metrics — not just "did it 200", but *why* it was fast
// or slow, so a bottleneck actually points at its real cause.
//
// Usage:
//   node scripts/load-test.mjs --users=200 --duration=60
//   node scripts/load-test.mjs --users=20 --duration=20 --base=http://localhost:8060
//
// Each simulated user repeatedly "opens a city" — fetches a realistic
// batch of basemap + GWC + WFS requests for a semi-random viewport within
// that city's real boundary, at a semi-random zoom (13-16), the same shape
// of traffic MapContainer.jsx actually generates when a real user pans/
// zooms — then pauses briefly (simulating human pacing) before repeating,
// for the configured duration.
import "dotenv/config";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import { storeActiveToken } from "../server/src/middleware/authMiddleware.js";
import { parseCityRegistry } from "../server/src/services/cacheWarmer.js";
import { fetchBoundaryRings, MERCATOR_ORIGIN, STYLES } from "../server/src/routes/tiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  })
);

const BASE_URL = (args.base || "http://localhost:8060").replace(/\/$/, "");
const NUM_USERS = Number(args.users || 20);
const DURATION_SEC = Number(args.duration || 30);
const NUM_TOKENS = Math.min(NUM_USERS, Number(args.tokens || 20));
const PACE_MIN_MS = Number(args.paceMin || 200);
const PACE_MAX_MS = Number(args.paceMax || 1200);

console.log(
  `Load test: ${NUM_USERS} concurrent users, ${DURATION_SEC}s, base=${BASE_URL}, ${NUM_TOKENS} distinct sessions`
);

// ---------------------------------------------------------------------
// 1) Mint a small pool of real, legitimate test sessions (same JWT + DB
//    active_tokens mechanism as a real login) rather than hardcoding/
//    guessing any credential. Virtual users round-robin across this pool,
//    matching "N users, fewer than N being logged in at once" realistically
//    without needing NUM_USERS separate DB rows.
// ---------------------------------------------------------------------
async function mintTestSessions(count) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set — run this from server/.env's environment");
  const tokens = [];
  for (let i = 0; i < count; i += 1) {
    const payload = {
      user_id: `load-test-user-${i}`,
      username: `load-test-user-${i}`,
      role: "user",
      city: "kanpur",
    };
    const token = jwt.sign(payload, secret, { expiresIn: "30m" });
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
    await storeActiveToken({ token, userId: payload.user_id, issuedAt, expiresAt });
    tokens.push(token);
  }
  return tokens;
}

// ---------------------------------------------------------------------
// 2) Build a real per-city viewport generator from the actual boundary
//    bboxes (same source cacheWarmer.js uses) so simulated traffic spans
//    genuinely different tiles across cities/zooms — a mix of already-warm
//    (cache hit) and cold (cache miss) tiles, not everyone hammering one
//    pre-cached tile.
// ---------------------------------------------------------------------
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

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[randomInt(0, arr.length - 1)];

async function buildCityViewports() {
  const cities = parseCityRegistry();
  const entries = Object.entries(cities)
    .map(([key, city]) => ({ key, city, boundary: city.zoneLayer || city.wardLayer }))
    .filter((e) => e.boundary);

  const viewports = [];
  for (const entry of entries) {
    try {
      const { bbox } = await fetchBoundaryRings(entry.boundary);
      viewports.push({ ...entry, bbox });
    } catch (err) {
      console.warn(`Skipping ${entry.key}: boundary fetch failed (${err.message})`);
    }
  }
  return viewports;
}

function randomTileFor(viewport, z) {
  const range = tileRangeForBbox(viewport.bbox, z);
  return { z, x: randomInt(range.xMin, range.xMax), y: randomInt(range.yMin, range.yMax) };
}

// ---------------------------------------------------------------------
// 3) One "session action" — the request batch a real user's browser fires
//    when opening/panning to a city viewport: a few basemap styles, the
//    zone/ward boundary + road network GWC layers, and one WFS road-detail
//    call. Mirrors MapContainer.jsx's actual layer set, not a synthetic
//    single-endpoint hammer.
// ---------------------------------------------------------------------
const results = [];

async function timedFetch(category, url, token) {
  const startedAt = Date.now();
  let status = 0;
  let cache = null;
  let error = null;
  try {
    const res = await fetch(url, { headers: { Cookie: `auth_token=${token}` } });
    status = res.status;
    cache = res.headers.get("x-cache");
    // Drain the body so the connection is actually freed/timed realistically.
    await res.arrayBuffer();
  } catch (err) {
    error = err.message;
  }
  results.push({ category, status, cache, error, durationMs: Date.now() - startedAt, ts: startedAt });
}

async function simulateOneAction(viewport, token) {
  const z = randomInt(13, 16);
  const tile = randomTileFor(viewport, z);
  const style = pick(Object.keys(STYLES));

  const tasks = [
    timedFetch(
      `basemap:${style}`,
      `${BASE_URL}/api/tiles/${style}/${tile.z}/${tile.x}/${tile.y}.png?boundary=${encodeURIComponent(viewport.boundary)}`,
      token
    ),
  ];
  for (const layerKey of ["zoneLayer", "wardLayer", "roadLayer"]) {
    const layer = viewport.city[layerKey];
    if (!layer) continue;
    tasks.push(
      timedFetch(
        `gwc:${layerKey}`,
        `${BASE_URL}/api/gwc-tiles/${encodeURIComponent(layer)}/${tile.z}/${tile.x}/${tile.y}.png`,
        token
      )
    );
  }
  if (viewport.city.roadLayer) {
    const [minX, minY, maxX, maxY] = viewport.bbox;
    tasks.push(
      timedFetch(
        "wfs:road-detail",
        `${BASE_URL}/api/road-wfs-cache?layer=${encodeURIComponent(viewport.city.roadLayer)}` +
          `&bbox=${minX},${minY},${maxX},${maxY}&srsName=EPSG:3857&maxFeatures=200`,
        token
      )
    );
  }
  await Promise.all(tasks);
}

async function runVirtualUser(userIndex, tokens, viewports, stopAt) {
  const token = tokens[userIndex % tokens.length];
  while (Date.now() < stopAt) {
    const viewport = pick(viewports);
    await simulateOneAction(viewport, token);
    await new Promise((r) => setTimeout(r, randomInt(PACE_MIN_MS, PACE_MAX_MS)));
  }
}

// ---------------------------------------------------------------------
// 4) Poll the live /api/internal/metrics endpoint throughout the run so
//    the final report can show limiter queue depth / event-loop lag over
//    time, not just a single before/after snapshot.
// ---------------------------------------------------------------------
const metricsTimeline = [];
async function pollMetrics(adminToken, stopAt) {
  while (Date.now() < stopAt) {
    try {
      const res = await fetch(`${BASE_URL}/api/internal/metrics`, {
        headers: { Cookie: `auth_token=${adminToken}` },
      });
      if (res.ok) metricsTimeline.push({ ...(await res.json()), pollTs: Date.now() });
    } catch {
      // best-effort
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function mintAdminSession() {
  const secret = process.env.JWT_SECRET;
  const payload = { user_id: "load-test-admin", username: "load-test-admin", role: "admin", city: null };
  const token = jwt.sign(payload, secret, { expiresIn: "30m" });
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
  await storeActiveToken({ token, userId: payload.user_id, issuedAt, expiresAt });
  return token;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(rows) {
  const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
  const errors = rows.filter((r) => r.error || r.status >= 400);
  return {
    count: rows.length,
    errorCount: errors.length,
    errorRate: rows.length ? +((errors.length / rows.length) * 100).toFixed(2) : 0,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] || 0,
    min: durations[0] || 0,
  };
}

async function main() {
  console.log("Building per-city viewports from real boundary data...");
  const viewports = await buildCityViewports();
  console.log(`Loaded ${viewports.length} city viewports.`);

  console.log(`Minting ${NUM_TOKENS} test sessions + 1 admin session...`);
  const tokens = await mintTestSessions(NUM_TOKENS);
  const adminToken = await mintAdminSession();

  const startedAt = Date.now();
  const stopAt = startedAt + DURATION_SEC * 1000;

  console.log(`Starting ${NUM_USERS} virtual users for ${DURATION_SEC}s...`);
  const userPromises = Array.from({ length: NUM_USERS }, (_, i) =>
    runVirtualUser(i, tokens, viewports, stopAt)
  );
  const metricsPromise = pollMetrics(adminToken, stopAt);

  await Promise.all([...userPromises, metricsPromise]);
  const elapsedSec = (Date.now() - startedAt) / 1000;

  console.log("\n================ LOAD TEST REPORT ================");
  console.log(`Duration: ${elapsedSec.toFixed(1)}s, Users: ${NUM_USERS}, Total requests: ${results.length}`);
  console.log(`Throughput: ${(results.length / elapsedSec).toFixed(1)} req/s\n`);

  const overall = summarize(results);
  console.log("Overall:", JSON.stringify(overall));

  console.log("\nBy category:");
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const rows = results.filter((r) => r.category === cat);
    console.log(`  ${cat.padEnd(20)} ${JSON.stringify(summarize(rows))}`);
  }

  console.log("\nBy cache status:");
  for (const cacheStatus of ["HIT", "MISS", "STALE", null]) {
    const rows = results.filter((r) => (r.cache || null) === cacheStatus);
    if (!rows.length) continue;
    console.log(`  ${String(cacheStatus).padEnd(10)} ${JSON.stringify(summarize(rows))}`);
  }

  const errorSamples = results.filter((r) => r.error || r.status >= 400).slice(0, 10);
  if (errorSamples.length) {
    console.log("\nSample errors:");
    for (const e of errorSamples) {
      console.log(`  ${e.category} status=${e.status} error=${e.error || ""}`);
    }
  }

  console.log("\nServer metrics timeline (sampled every ~3s during the test):");
  for (const m of metricsTimeline) {
    console.log(
      `  +${Math.round((m.pollTs - startedAt) / 1000)}s ` +
        `eventLoop(mean=${m.eventLoopDelay.meanMs}ms,p99=${m.eventLoopDelay.p99Ms}ms) ` +
        `mem(rss=${m.memory.rssMb}MB) ` +
        `geoserverLimiter(active=${m.geoserverLimiter.active}/${m.geoserverLimiter.maxConcurrent},` +
        `queued=${m.geoserverLimiter.normalQueued}+${m.geoserverLimiter.lowQueued}low,avgWait=${m.geoserverLimiter.avgWaitMs}ms)`
    );
  }
  console.log("====================================================\n");

  // Write full raw results + metrics timeline to disk for further analysis.
  const fs = await import("fs");
  const outPath = path.join(__dirname, "..", "server", "logs", `load-test-${Date.now()}.json`);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(
    outPath,
    JSON.stringify({ config: { NUM_USERS, DURATION_SEC, BASE_URL }, results, metricsTimeline }, null, 2)
  );
  console.log(`Full raw results written to ${outPath}`);

  if (overall.errorRate > 1) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exitCode = 1;
});
