// Standalone CLI diagnostics for the Smart Shared Cache Delivery Engine —
// the non-HTTP equivalent of GET /api/internal/cache-diagnostics, for a
// sysadmin on the box without a browser session / admin JWT.
//
// Usage (from server/):
//   node src/scripts/cache-diagnostics.mjs
//   node src/scripts/cache-diagnostics.mjs --deep   # also walks the disk
//                                                    # tree to estimate
//                                                    # unindexed files
//                                                    # (~15-60s for ~1.4M
//                                                    # files - same cost as
//                                                    # the one-time backfill)
//
// Read-only. Does not start the Express app, does not touch Nginx/GeoServer,
// does not delete anything — it only opens the same cache-index.sqlite the
// running app uses (WAL mode allows a second reader concurrently) and
// prints a JSON report.
import * as cacheIndex from "../cache/cacheIndex.js";
import * as cacheMetrics from "../cache/cacheMetrics.js";

const deep = process.argv.includes("--deep");

const health = await cacheIndex.getIndexHealthReport({ includeUnindexedEstimate: deep });
const report = {
  generatedAt: new Date().toISOString(),
  metrics: cacheMetrics.snapshot(),
  health,
  eviction: {
    config: cacheIndex.getEvictionConfigSnapshot(),
    lastResult: cacheIndex.getLastEvictionResult(),
  },
  hitAccumulator: cacheIndex.getHitAccumulatorStats(),
  dbPath: cacheIndex.getDbPathForDiagnostics(),
  note:
    "eviction.lastResult and promiseManager in-flight counts are per-process, in-memory state — " +
    "this script is a separate, short-lived process, so those will read null/empty here even while " +
    "the live server has real values. Use GET /api/internal/cache-diagnostics (admin-only) for those.",
};

console.log(JSON.stringify(report, null, 2));
