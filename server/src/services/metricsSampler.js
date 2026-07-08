import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { monitorEventLoopDelay } from "perf_hooks";
import { geoserverLimiter, basemapLimiter } from "../utils/concurrencyLimiter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_LOG_FILE = path.join(__dirname, "..", "..", "logs", "metrics.log");
const SAMPLE_INTERVAL_MS = 5000;

// Node is single-threaded for JS execution — under load, the real early
// warning sign isn't CPU% (that's an OS-level, multi-process view) but
// *event-loop lag*: how much longer a scheduled timer callback actually
// takes to fire than requested. Rising lag means requests are queueing
// behind synchronous work (e.g. sharp's image compositing in
// tiles.js's getMaskedTile) rather than truly running concurrently.
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

function snapshot() {
  const mem = process.memoryUsage();
  const loop = {
    meanMs: Math.round((eventLoopMonitor.mean || 0) / 1e6),
    maxMs: Math.round((eventLoopMonitor.max || 0) / 1e6),
    p99Ms: Math.round((eventLoopMonitor.percentile(99) || 0) / 1e6),
  };
  return {
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    eventLoopDelay: loop,
    geoserverLimiter: geoserverLimiter.stats(),
    basemapLimiter: basemapLimiter.stats(),
  };
}

// Exported for a live "what's happening right now" view (see the
// /api/internal/metrics route in app.js) — separate from the periodic
// logged samples below, since a load test benefits from polling this on
// demand rather than only reading after the fact from a log file.
export function getCurrentMetrics() {
  return snapshot();
}

export function startMetricsSampler() {
  setInterval(() => {
    const line = JSON.stringify(snapshot()) + "\n";
    fs.mkdir(path.dirname(METRICS_LOG_FILE), { recursive: true }, () => {
      fs.appendFile(METRICS_LOG_FILE, line, () => {});
    });
    eventLoopMonitor.reset();
  }, SAMPLE_INTERVAL_MS);
}
