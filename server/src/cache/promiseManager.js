// SharedTilePromiseManager — a generic "one in-flight promise per canonical
// cache key" de-duplicator, with per-request refcounting and abort-on-
// last-disconnect semantics.
//
// tiles.js already has an equivalent hand-rolled version of this exact
// pattern (its `inFlight` Map + `trackAbortableClient`) for the raw/GWC/
// filtered-WMS tile fetch paths, and that one is left as-is in Phase 1 —
// it already works and touching it is out of scope for "wrap gradually".
// This module exists so *new* call sites (starting with
// fetchBoundaryGeoJson/fetchBoundaryRings in tiles.js, which today has NO
// in-flight de-dup at all — two concurrent misses for the same boundary
// both hit GeoServer) get the same protection without duplicating the
// logic a third time, and so future cache families can reuse it too.
//
// Deliberately does NOT use Promise.all/Promise.race over a list of keys —
// each key gets its own independent entry; nothing here ever holds more
// than one canonical key's promise set at a time, so there's no risk of
// the "huge tile list in one Promise.all" pattern this phase's
// requirements explicitly warn against.
export class SharedTilePromiseManager {
  constructor({ defaultTimeoutMs = 0 } = {}) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.entries = new Map(); // cacheKey -> { promise, controller, refCount, timer }
  }

  size() {
    return this.entries.size;
  }

  // Runs `fn(signal)` at most once per `cacheKey` no matter how many
  // concurrent callers ask for it; every caller after the first just rides
  // the same promise. `req` (optional Express request) gets its
  // disconnect tracked against the shared refcount — the underlying
  // AbortController only fires once every caller currently waiting has
  // gone away, not on the first one, so one abandoned tab doesn't cancel
  // work three other users are still waiting on.
  //
  // Complexity: O(1) — a single Map get/set keyed on the canonical cache
  // key, regardless of how many concurrent callers share it. The map only
  // ever holds entries for keys with a fetch genuinely in flight right now
  // (removed in the `.finally()` the instant that fetch settles), so its
  // size is bounded by concurrent in-flight fetches, not by request
  // history — it cannot grow unbounded over the life of the process.
  async run(cacheKey, fn, { req, timeoutMs } = {}) {
    let entry = this.entries.get(cacheKey);
    if (!entry) {
      const controller = new AbortController();
      const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
      let timer = null;
      if (effectiveTimeout > 0) {
        timer = setTimeout(() => controller.abort(new Error("SharedTilePromiseManager: timeout")), effectiveTimeout);
      }
      const promise = Promise.resolve()
        .then(() => fn(controller.signal))
        .finally(() => {
          if (timer) clearTimeout(timer);
          this.entries.delete(cacheKey);
        });
      entry = { promise, controller, refCount: 0 };
      this.entries.set(cacheKey, entry);
    }
    this._trackClient(entry, req);
    return entry.promise;
  }

  _trackClient(entry, req) {
    if (!req) return;
    entry.refCount += 1;
    let decremented = false;
    const decrementOnce = () => {
      if (decremented) return;
      decremented = true;
      entry.refCount -= 1;
      if (entry.refCount <= 0) entry.controller.abort(new Error("SharedTilePromiseManager: all clients disconnected"));
    };
    req.on("close", decrementOnce);
    entry.promise.finally(decrementOnce).catch(() => {});
  }

  // Diagnostics only — not on any request path.
  stats() {
    return {
      inFlightKeys: this.entries.size,
      keys: Array.from(this.entries.keys()),
    };
  }
}

// One process-wide instance is enough for Phase 1's new call sites
// (boundary rings/geojson). Each PM2 cluster worker gets its own instance,
// same as tiles.js's existing per-worker `inFlight` Map — in-flight de-dup
// is inherently per-process, not cross-process.
export const sharedTilePromiseManager = new SharedTilePromiseManager();

export default SharedTilePromiseManager;
