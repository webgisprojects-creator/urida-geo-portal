# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Chainage patch-creation/viewing workflow merged into the existing per-city
  Dashboard as an in-place mode (no more separate `/chainage` page that
  discarded the user's current filters/zoom) — select a road, view or
  create patches, preview the exact segment before saving. `/chainage`
  deep links (KMC mobile field-task integration) still work as a redirect
  into this same in-place mode.
- Server-side tile caching/masking (`server/src/routes/tiles.js`): basemap
  tiles are clipped to each city's/UP state's real boundary shape and
  cached on disk (30-day TTL), shared across every user instead of every
  browser redoing the same clip on every frame. GeoServer/GWC overlay
  layers (Zone/Ward Boundary, Road Network, classifications, LCLU) get the
  same disk-cache treatment with a 1-hour TTL, since that's real editable
  data rather than eternal imagery.
- Background cache pre-warming (`server/src/services/cacheWarmer.js`): runs
  automatically and non-blockingly at server startup, warming basemap and
  GWC tiles zoom-tier by zoom-tier across every city and the UP-wide view
  (shallowest zoom everywhere first, before going deeper anywhere) so the
  cache is populated ahead of real traffic instead of relying purely on
  on-demand caching. Uses a low-priority request queue (see Fixed) so
  warming never delays a real user's request.
- Request concurrency limiting (`server/src/utils/concurrencyLimiter.js`)
  for outbound GeoServer/basemap-provider requests, with a two-tier
  priority queue (real requests vs. background warming).
- WFS response caching (`server/src/routes/wfsCache.js`) for the
  road-network detail layer used for precise map click hit-testing.
- Client-side map-loading tracker + telemetry
  (`client/src/utils/mapLoadingTracker.js`, `client/src/utils/telemetry.js`)
  — accurate, auto-recovering loading indicators instead of one that could
  get stuck indefinitely on a single wedged tile.
- Shared `getGeoserverBase()` util, replacing 7 independent (and, in every
  case, buggy — hardcoded to a local `:8080` GeoServer that doesn't exist in
  this deployment) copies of the same GeoServer-base-URL logic.

### Fixed
- Zone/Ward boundary layers were silently missing their colored
  stroke/zone_no/ward_no number labels on the map (regression introduced
  while wiring up the new GWC tile cache — the cache route has no way to
  carry a dynamic per-request `SLD_BODY`). Fixed by restoring the style
  application and making the cache path bypass itself whenever a live style
  is set, mirroring how a live `CQL_FILTER` already bypasses it.
- Road-click and popup-close callbacks into Dashboard could freeze on
  their very first render's closure and silently stop reflecting later
  state (stale `useRef` never resynced after a refactor removed its sync
  effect) — affected normal road-click/table-highlight behavior for every
  city, not just chainage.
- The background cache warmer could starve a real user's request behind a
  deep backlog of its own low-priority work right after a restart (observed
  directly: a real request queued behind an active warming pass timed out
  after 17s with a 502). Fixed with a two-tier priority queue — queued
  warming work now always yields to a request that arrives after it.
- Toggling Chainage mode on/off with no filter active could snap the map
  back to the city's default view, discarding the user's current pan/zoom.
- WFS bbox queries silently returned zero features when the CRS suffix was
  omitted from the `bbox` parameter (GeoServer falls back to interpreting
  the layer's native CRS instead of erroring).

### Security
- `server/src/routes/chainage.js` (patch create/view — DB writes) and the
  new tile/WFS-cache proxy routes had no authentication at all, unlike
  every other route file in this codebase. Added the same `verifyToken`
  gate used elsewhere; every real path into these features (including the
  KMC mobile deep-link) already requires login first, so this is
  transparent to real users.
- The tile/GWC/WFS proxy routes accepted an arbitrary GeoServer layer name
  with no whitelist, allowing any authenticated caller to probe or request
  any layer on the shared GeoServer instance. Restricted to the known set
  of layers actually used by this app (derived from `cityConfig.js`).

### Database
- Added 99 missing GIST spatial indexes across all 17 cities' amenity-proximity
  materialized views and street-light/underdeveloped-zone analysis layers.
- Added B-tree indexes on filter columns (zone_no, ward_no, condition, category,
  material, ownership, cus_class, road_id, gis_id) actually used by the app's
  query code.
- Tuned `random_page_cost` (4 → 1.1) and `effective_cache_size` (12GB → 20GB)
  for confirmed SSD storage — applied without a restart.
- Increased `shared_buffers` (4GB → 8GB, ~25% of host RAM) — the one setting
  in this pass that required a Postgres restart; applied and verified
  end-to-end afterward. Full details and rollback steps in `docs/DB_NOTES.md`.

## [1.0.0] - 2026-02-24
### Added
- Comprehensive system documentation in `PROJECT_ANALYSIS.md`.
- PM2 process management configuration `ecosystem.config.js`.
- Initial `README.md` and `CHANGELOG.md`.

### Infrastructure
- Identified Nginx configuration and SSL setup.
- Identified Node.js backend running on port 8060.
- Identified GeoServer running on port 8080.
- Documented LocalTunnel usage for public access.
