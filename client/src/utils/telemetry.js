// Lightweight, best-effort action/timing logger — ships to
// POST /api/telemetry (server/src/routes/telemetry.js), which appends each
// event to server/logs/telemetry.log. Built specifically so real usage
// (what a user actually clicked/panned/toggled, and how long each layer
// genuinely took to load or whether it got stuck) can be read back after
// the fact instead of guessed at, without needing live browser access.
//
// Batches events for ~500ms (or forces a flush past 20 queued) so a burst
// of activity doesn't fire a request per event, and flushes on page
// unload via sendBeacon so nothing is lost when navigating away.
const ENDPOINT = "/api/telemetry";
const FLUSH_DELAY_MS = 500;
const MAX_QUEUE = 20;

const SESSION_ID =
  (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let queue = [];
let flushTimer = null;

function flush() {
  if (!queue.length) return;
  const events = queue;
  queue = [];
  clearTimeout(flushTimer);
  flushTimer = null;
  const body = JSON.stringify({ events });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    } else {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // best-effort only — never let logging itself throw
  }
}

export function logEvent(type, details = {}) {
  queue.push({
    type,
    details,
    ts: Date.now(),
    path: `${window.location.pathname}${window.location.search}`,
    sessionId: SESSION_ID,
  });
  if (queue.length >= MAX_QUEUE) {
    flush();
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
}

// ---------------------------------------------------------------------
// Resource Timing + Long Task observation — this is the browser's own,
// authoritative measurement of every network request and every main-thread
// stall, not something hand-rolled per feature. It catches everything the
// manual instrumentation elsewhere (mapLoadingTracker, beginLoading/
// endLoading) might miss — WFS amenity fetches, JS/CSS asset loads, a
// fallback tile URL, anything — with real transfer sizes and durations
// straight from the browser. No extension or dependent software needed;
// Edge (Chromium) supports both natively.
// ---------------------------------------------------------------------

// Groups a request URL into a stable bucket so a burst of 40 basemap tiles
// or 12 GWC tiles produces one aggregated log line instead of 40, while
// still distinguishing which *kind* of request was slow.
function bucketForUrl(url) {
  try {
    const { pathname } = new URL(url, window.location.origin);
    const tileMatch = pathname.match(/^\/api\/tiles\/([^/]+)/);
    if (tileMatch) return `basemap:${tileMatch[1]}`;
    const gwcMatch = pathname.match(/^\/api\/gwc-tiles\/([^/]+)/);
    if (gwcMatch) return `gwc-layer:${decodeURIComponent(gwcMatch[1])}`;
    if (pathname.startsWith("/geoserver/")) return "geoserver-direct";
    if (pathname.startsWith("/api/road-networks/")) return "road-networks-api";
    if (pathname.startsWith("/api/")) return `api:${pathname.split("/")[2] || ""}`;
    if (/\.(js|css)$/.test(pathname)) return "app-bundle";
    return null; // not something we care to track (fonts, icons, etc.)
  } catch {
    return null;
  }
}

const RESOURCE_FLUSH_MS = 3000;
let resourceBuckets = new Map(); // bucket -> { count, totalMs, maxMs, cacheHits, bytes }
let resourceFlushTimer = null;

function flushResourceBuckets() {
  if (!resourceBuckets.size) return;
  const buckets = resourceBuckets;
  resourceBuckets = new Map();
  clearTimeout(resourceFlushTimer);
  resourceFlushTimer = null;
  for (const [bucket, stats] of buckets) {
    logEvent("network_bucket", {
      bucket,
      count: stats.count,
      avgMs: Math.round(stats.totalMs / stats.count),
      maxMs: Math.round(stats.maxMs),
      cacheHits: stats.cacheHits,
      totalBytes: stats.bytes,
    });
  }
}

function recordResourceEntry(entry) {
  const bucket = bucketForUrl(entry.name);
  if (!bucket) return;
  const stats = resourceBuckets.get(bucket) || { count: 0, totalMs: 0, maxMs: 0, cacheHits: 0, bytes: 0 };
  stats.count += 1;
  stats.totalMs += entry.duration;
  stats.maxMs = Math.max(stats.maxMs, entry.duration);
  // transferSize === 0 on an otherwise-successful entry means the browser
  // served it from its own HTTP cache without hitting the network at all.
  if (entry.transferSize === 0 && entry.duration > 0) stats.cacheHits += 1;
  stats.bytes += entry.transferSize || 0;
  resourceBuckets.set(bucket, stats);
  clearTimeout(resourceFlushTimer);
  resourceFlushTimer = setTimeout(flushResourceBuckets, RESOURCE_FLUSH_MS);
}

if (typeof PerformanceObserver !== "undefined") {
  try {
    const resourceObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach(recordResourceEntry);
    });
    resourceObserver.observe({ type: "resource", buffered: true });
  } catch {
    // Resource Timing not available in this browser — telemetry just has
    // less detail, nothing breaks.
  }

  try {
    // A "long task" is >50ms of unbroken main-thread work — the browser's
    // own definition of "the UI just froze." Logged individually (rare
    // enough not to flood) so a genuinely jittery interaction shows up as
    // a cluster of these around the same timestamp as the user action that
    // caused it.
    const longTaskObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        logEvent("long_task", {
          durationMs: Math.round(entry.duration),
          startedAtMs: Math.round(entry.startTime),
        });
      });
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    // Long Tasks API not available — non-fatal, same as above.
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flushResourceBuckets);
    window.addEventListener("pagehide", flushResourceBuckets);
  }
}
