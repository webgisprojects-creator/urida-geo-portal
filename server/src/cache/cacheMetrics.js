// In-memory (per-process) counters for the Smart Shared Cache Delivery
// Engine, in the same spirit as server/src/services/metricsSampler.js's
// existing live snapshot — cheap, no persistence, reset on restart. Not
// wired into any request-blocking path; recording a count is an O(1) map
// update.
const counters = new Map(); // `${family}:${event}` -> count

function bump(family, event) {
  const key = `${family}:${event}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

export function recordHit(family) {
  bump(family, "hit");
}
export function recordMiss(family) {
  bump(family, "miss");
}
export function recordStale(family) {
  bump(family, "stale");
}
export function recordFallback(family, tier) {
  bump(family, "fallback");
  if (tier) bump(family, `fallback:${tier}`);
}
export function recordDenied(family) {
  bump(family, "denied");
}

export function snapshot() {
  const out = {};
  for (const [key, count] of counters.entries()) {
    const [family, event] = key.split(":", 2);
    out[family] = out[family] || {};
    out[family][event] = count;
  }
  return out;
}

export default { recordHit, recordMiss, recordStale, recordFallback, recordDenied, snapshot };
