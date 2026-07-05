// Caps how many outbound upstream requests can be in flight at once.
// Confirmed via real usage telemetry: layers that individually respond in
// ~0.2-1.3s were averaging 2-10 *seconds* during real use, because 5-6+
// layers each fire dozens of simultaneous requests the moment a city opens
// or the map pans — everything queues/contends for the same outbound
// connections and degrades together. This doesn't make any single request
// faster than its true best-case time, but it stops an unbounded burst
// from making every request in that burst slower than it needs to be.
//
// Two priority tiers share the same concurrency budget: real user requests
// (tiles.js/wfsCache.js route handlers) run at normal priority; the
// background cache-warmer (server/src/services/cacheWarmer.js) runs at low
// priority. Confirmed via a live test: without this split, a warming pass
// in progress right after a restart queued a real /api/road-wfs-cache
// request behind a deep backlog of warmer jobs and it timed out with a 502
// after 17s — a plain FIFO queue has no way to let a request that arrives
// *later* jump ahead of already-queued low-priority work. The drain loop
// below always empties the normal-priority queue first; low-priority work
// only proceeds when nothing normal-priority is waiting, so warming still
// makes progress during idle periods but never blocks real traffic.
//
// Usage:
//   const limiter = createLimiter(8);
//   await limiter(() => fetch(...));           // normal priority
//   await limiter.low(() => fetch(...));        // low priority (warmer only)
export function createLimiter(maxConcurrent) {
  let active = 0;
  const normalQueue = [];
  const lowQueue = [];

  function drain() {
    while (active < maxConcurrent) {
      const queue = normalQueue.length > 0 ? normalQueue : lowQueue;
      if (queue.length === 0) return;
      active += 1;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(
          (result) => {
            active -= 1;
            resolve(result);
            drain();
          },
          (err) => {
            active -= 1;
            reject(err);
            drain();
          }
        );
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      normalQueue.push({ fn, resolve, reject });
      drain();
    });
  }

  run.low = function runLow(fn) {
    return new Promise((resolve, reject) => {
      lowQueue.push({ fn, resolve, reject });
      drain();
    });
  };

  return run;
}

// One shared limiter per upstream "destination" — GeoServer (our own
// infrastructure, where we've directly observed contention) gets its own
// budget separate from third-party basemap providers (OSM/CartoDB/Esri),
// since those are independent services with their own separate rate limits
// and shouldn't compete with or be throttled by GeoServer traffic.
export const geoserverLimiter = createLimiter(8);
export const basemapLimiter = createLimiter(10);
