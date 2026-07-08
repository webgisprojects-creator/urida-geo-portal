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
//   limiter.stats();                            // { active, queued, ... } — see below
export function createLimiter(maxConcurrent) {
  let active = 0;
  let activeLow = 0;
  const normalQueue = [];
  const lowQueue = [];

  // The normal-queue-first check above only decides which queue a *new*
  // slot goes to — it does nothing once low-priority jobs are already
  // running. Confirmed live: right after a restart, the cache-warmer's
  // fan-out (24, same as this limiter's whole budget) filled every slot
  // with in-flight low-priority tile jobs (geoserverLimiter reporting
  // active:24/24, completedCount climbing) for 20+ minutes straight. A real
  // request arriving in that window still has to wait for one of those
  // already-started jobs to finish — each one 4-9s against this
  // environment's GeoServer — before it can even begin, regardless of
  // queue ordering. Capping how many slots low-priority work may ever
  // *occupy* (not just queue into) guarantees real traffic always has free
  // capacity, at the cost of the warmer finishing more slowly.
  const lowPriorityCap = Math.max(1, Math.floor(maxConcurrent * 0.6));

  // Running totals for observability (server/src/services/metricsSampler.js,
  // load-test reporting): without this, queue backpressure is invisible —
  // you'd only infer it indirectly from response times, same blind spot
  // that let the cache-warmer starvation bug go unnoticed until a live test
  // happened to catch it.
  let completedCount = 0;
  let totalWaitMs = 0;
  let maxWaitMs = 0;

  function drain() {
    while (active < maxConcurrent) {
      const canRunLow = lowQueue.length > 0 && activeLow < lowPriorityCap;
      const queue = normalQueue.length > 0 ? normalQueue : canRunLow ? lowQueue : null;
      if (!queue) return;
      const isLow = queue === lowQueue;
      active += 1;
      if (isLow) activeLow += 1;
      const { fn, resolve, reject, enqueuedAt } = queue.shift();
      const waitMs = Date.now() - enqueuedAt;
      totalWaitMs += waitMs;
      if (waitMs > maxWaitMs) maxWaitMs = waitMs;
      completedCount += 1;
      Promise.resolve()
        .then(fn)
        .then(
          (result) => {
            active -= 1;
            if (isLow) activeLow -= 1;
            resolve(result);
            drain();
          },
          (err) => {
            active -= 1;
            if (isLow) activeLow -= 1;
            reject(err);
            drain();
          }
        );
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      normalQueue.push({ fn, resolve, reject, enqueuedAt: Date.now() });
      drain();
    });
  }

  run.low = function runLow(fn) {
    return new Promise((resolve, reject) => {
      lowQueue.push({ fn, resolve, reject, enqueuedAt: Date.now() });
      drain();
    });
  };

  run.stats = function stats() {
    return {
      active,
      activeLow,
      lowPriorityCap,
      maxConcurrent,
      normalQueued: normalQueue.length,
      lowQueued: lowQueue.length,
      completedCount,
      avgWaitMs: completedCount ? Math.round(totalWaitMs / completedCount) : 0,
      maxWaitMs,
    };
  };

  return run;
}

// These limiters are in-process state. Under PM2 cluster mode (see
// deploy/ecosystem.config.js), each worker gets its own independent copy —
// a cap of 24 would mean 24 x N-workers concurrent GeoServer requests in
// aggregate, not 24 total. PM2 sets `process.env.instances` to the real,
// resolved worker count in every worker (confirmed directly: started a
// PM2 cluster locally and inspected it) — dividing the intended aggregate
// cap by that count keeps the *whole cluster's* concurrent load against
// GeoServer/basemap providers at roughly the same evidence-based ceiling
// regardless of how many workers happen to be running, with a floor so a
// high worker count never squeezes any single worker down to nothing.
const CLUSTER_SIZE = Math.max(1, Number(process.env.instances) || 1);
const perWorker = (aggregateCap, floor = 3) => Math.max(floor, Math.round(aggregateCap / CLUSTER_SIZE));

// One shared limiter per upstream "destination" — GeoServer (our own
// infrastructure, where we've directly observed contention) gets its own
// budget separate from third-party basemap providers (OSM/CartoDB/Esri),
// since those are independent services with their own separate rate limits
// and shouldn't compete with or be throttled by GeoServer traffic.
//
// Raised 8 -> 24 (aggregate) after a 200-concurrent-user load test: with
// the DB-pool/session-cache bottleneck fixed, this became the next real
// ceiling — the queue grew unboundedly under sustained load (200+
// backlog, 10s+ avg wait, still climbing after 60s) while GeoServer's own
// host stayed at load average 0.01-0.14 throughout (out of 4 vCPUs) —
// i.e. the limit was purely self-imposed, not GeoServer running out of
// real capacity.
export const geoserverLimiter = createLimiter(perWorker(24));
export const basemapLimiter = createLimiter(perWorker(10));
