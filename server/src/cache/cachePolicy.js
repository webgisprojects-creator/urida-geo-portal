// Cache share-scope + TTL + family-cap policy for the Smart Shared Cache
// Delivery Engine. Pure config/lookup module — no filesystem, no network.
//
// share_scope describes *who else* may reuse a given cached entry, not
// whether the requester is authenticated (every route in tiles.js/
// wfsCache.js already sits behind verifyToken — see tileAccessPolicy.js
// for the actual per-request access check built on top of this table).
const SHARE_SCOPE_BY_FAMILY = {
  basemap: "global",
  "clipped-basemap": "boundary",
  gwc: "layer",
  "wms-filtered": "filter",
  "boundary-geojson": "city",
  "wfs-bbox": "bbox-filter",
  getfeatureinfo: "none",
  private: "user",
  temp: "user",
  "user-specific": "user",
};

export function getShareScope(family) {
  return SHARE_SCOPE_BY_FAMILY[family] || "none";
}

// Freshness windows. These intentionally mirror the TTLs already in
// production use in tiles.js/wfsCache.js (GWC_TILE_TTL_MS, FILTERED_WMS_TTL_MS,
// BOUNDARY_TTL_MS, wfsCache.js's CACHE_TTL_MS) rather than inventing new
// numbers — Phase 1 wraps existing behavior, it doesn't retune it.
const FRESH_TTL_MS = {
  basemap: 30 * 24 * 60 * 60 * 1000, // 30 days - imagery is effectively eternal
  "clipped-basemap": 30 * 24 * 60 * 60 * 1000,
  gwc: 60 * 60 * 1000, // 1 hour
  "wms-filtered": 60 * 60 * 1000,
  "boundary-geojson": 60 * 60 * 1000,
  "wfs-bbox": 3 * 60 * 1000,
};

// How long past FRESH_TTL_MS a cached entry may still be served as STALE
// (upstream failed / not yet refreshed) before FallbackManager must move on
// to the next tier. Generous relative to fresh TTL — a stale tile is still
// far better than nothing for read-mostly GIS layers.
const STALE_TTL_MS = {
  basemap: 365 * 24 * 60 * 60 * 1000,
  "clipped-basemap": 365 * 24 * 60 * 60 * 1000,
  gwc: 24 * 60 * 60 * 1000,
  "wms-filtered": 24 * 60 * 60 * 1000,
  "boundary-geojson": 24 * 60 * 60 * 1000,
  "wfs-bbox": 30 * 60 * 1000,
};

export function getFreshTtlMs(family) {
  return FRESH_TTL_MS[family] ?? 60 * 60 * 1000;
}

export function getStaleTtlMs(family) {
  return STALE_TTL_MS[family] ?? 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------
// Per-family disk caps, configurable via env so an operator can tune them
// without a code change (requirement: "family caps configurable by env").
// Defaults are set generously ABOVE this deployment's current on-disk
// footprint (audited: tile-cache is ~43G today, dominated by satellite/gwc)
// so that turning on the new indexed eviction sweep does NOT immediately
// treat the existing, legitimately-warmed cache as over-cap and start
// deleting it — see cacheIndex.js's eviction sweep and the rollout notes
// in this phase's README/PR description for how to safely ratchet these
// down later once the index has had time to backfill and stabilize.
// ---------------------------------------------------------------------
// Audited directly against this deployment's real cache-index.sqlite after
// the Phase 1 backfill completed (2026-07-09): basemap ~4.8G, clipped-basemap
// ~32.3G (dominated by per-city boundary-masked satellite imagery — most of
// this app's real-world basemap traffic is clipped, not raw), gwc ~1.8G,
// wms-filtered ~0.04G. Defaults below sit comfortably above each of those
// real numbers so enabling eviction never treats today's legitimately-warmed
// cache as over-cap. Ratchet down deliberately later, after reviewing
// cacheMetrics.js/cache-index.sqlite over a real observation window - do not
// lower these without checking current usage first (see the rollout notes
// in this phase's PR description for exactly this incident: an earlier,
// untuned 10G default for clipped-basemap evicted 500 real files within
// seconds of first being exercised against the true ~32G).
const DEFAULT_FAMILY_CAP_GB = {
  basemap: 40,
  "clipped-basemap": 45,
  gwc: 10,
  "wms-filtered": 5,
  "boundary-geojson": 1,
  "wfs-bbox": 2, // matches wfsCache.js's own existing 2GB cap
};

function envFamilyCapGb(family) {
  const envKey = `CACHE_CAP_GB_${family.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function getFamilyCapBytes(family) {
  const gb = envFamilyCapGb(family) ?? DEFAULT_FAMILY_CAP_GB[family] ?? 5;
  return gb * 1024 * 1024 * 1024;
}

// Overall safety-net cap across all indexed families combined, so a
// mis-configured single family cap can't let total disk usage run away.
// Defaults comfortably above the current ~43G footprint; override with
// CACHE_CAP_GB_TOTAL once the operator has reviewed real steady-state
// usage via cacheMetrics.js / the cache-index.sqlite contents.
export function getTotalCapBytes() {
  const raw = Number(process.env.CACHE_CAP_GB_TOTAL);
  const gb = Number.isFinite(raw) && raw > 0 ? raw : 100;
  return gb * 1024 * 1024 * 1024;
}

// Max files deleted per eviction batch (requirement: "max 500 files per
// batch"). Configurable in case a future deployment needs a different
// balance between sweep speed and per-tick I/O pressure.
export function getEvictionBatchSize() {
  const raw = Number(process.env.CACHE_EVICTION_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

// Defaults OFF. During Phase 1 testing on this exact deployment, turning
// this on with an under-estimated clipped-basemap cap (10G against a real
// ~32G) started deleting real, legitimately-warmed cache within seconds —
// see the DEFAULT_FAMILY_CAP_GB comment above. Eviction is fully
// implemented and crash-fixed (no more "Maximum call stack size exceeded"),
// but Phase 1 ships it opt-in: set CACHE_EVICTION_ENABLED=true once you've
// reviewed real per-family usage (cacheIndex.getFamilyStats via
// cacheMetrics.js or a direct query against cache-index.sqlite) against
// the caps above and are confident they won't touch anything you want kept.
export function isEvictionEnabled() {
  return String(process.env.CACHE_EVICTION_ENABLED || "false").toLowerCase() === "true";
}

// ---------------------------------------------------------------------
// Hardening pass (post-incident): CACHE_EVICTION_ENABLED alone is no
// longer sufficient to delete anything. Three independent gates now all
// have to be true before a single file is unlinked:
//   ENABLED  - "the eviction subsystem may run at all"
//   CONFIRM  - "an operator has deliberately turned this on for real use"
//              (distinct flag from ENABLED so a config template/.env.example
//              that flips ENABLED on by copy-paste still can't delete
//              anything by accident - CONFIRM has to be added by hand)
//   FORCE    - required specifically when a family is found over its cap;
//              this is the exact scenario that deleted 500 real files
//              during Phase 1 testing (an under-estimated cap), so "over
//              cap" now requires an extra, explicit acknowledgement rather
//              than silently proceeding just because the math says to.
// CACHE_EVICTION_DRY_RUN short-circuits AFTER logging what *would* have
// been deleted, regardless of the three gates above - safe to leave on
// permanently for observability.
// ---------------------------------------------------------------------
export function isEvictionConfirmed() {
  return String(process.env.CACHE_EVICTION_CONFIRM || "false").toLowerCase() === "true";
}

export function isEvictionForced() {
  return String(process.env.CACHE_EVICTION_FORCE || "false").toLowerCase() === "true";
}

export function isEvictionDryRun() {
  return String(process.env.CACHE_EVICTION_DRY_RUN || "false").toLowerCase() === "true";
}

export default {
  getShareScope,
  getFreshTtlMs,
  getStaleTtlMs,
  getFamilyCapBytes,
  getTotalCapBytes,
  getEvictionBatchSize,
  isEvictionEnabled,
  isEvictionConfirmed,
  isEvictionForced,
  isEvictionDryRun,
};
