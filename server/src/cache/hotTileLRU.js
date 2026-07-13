// Small, generic bounded in-memory LRU — for hot derived buffers that are
// cheap to recompute but expensive enough to be worth avoiding on a busy
// path (e.g. a boundary mask PNG re-rendered from the same rings/bbox for
// every basemap style at the same boundary/z/x/y). This is a pure CPU/
// compute-avoidance cache: it never touches disk, never changes what gets
// persisted to tile-cache, and is capped on three independent axes so it
// can never grow without bound:
//   - maxEntries: hard cap on distinct keys
//   - maxBytes:   hard cap on total buffer bytes held
//   - ttlMs:      entries older than this are treated as absent
// Eviction is plain LRU (Map iteration order = insertion/access order —
// re-inserting on access moves a key to the "most recently used" end).
export class HotTileLRU {
  constructor({ maxEntries = 500, maxBytes = 32 * 1024 * 1024, ttlMs = 60000 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { buffer, size, storedAt }
    this.totalBytes = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.map.delete(key);
      this.totalBytes -= entry.size;
      return null;
    }
    // Move to most-recently-used position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.buffer;
  }

  set(key, buffer) {
    const size = buffer.length;
    if (size > this.maxBytes) return; // never worth caching something bigger than the whole budget

    const existing = this.map.get(key);
    if (existing) this.totalBytes -= existing.size;
    this.map.set(key, { buffer, size, storedAt: Date.now() });
    this.totalBytes += size;

    while ((this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      this.totalBytes -= oldest.size;
    }
  }

  stats() {
    return { entries: this.map.size, totalBytes: this.totalBytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes };
  }
}

export default HotTileLRU;
