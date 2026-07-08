# Basemap tile caching, air-gapped operation, and MBTiles packaging

This covers the tile-proxy/cache-warmer/MBTiles system added to `server/src/routes/tiles.js`,
`server/src/services/cacheWarmer.js`, and `server/src/services/mbtilesExport.js`. Read this
before touching any of those files, or before deploying to a new environment.

## Why this exists

The portal serves free third-party basemap tiles (OSM, CartoDB Positron/dark, OpenTopoMap, Esri
World Imagery + Reference labels) to ~200 concurrent users on a government network that may get
internet access only a few times a year, for an unpredictable window (hours, not days). The whole
system is built around one constraint: **basemaps must keep working correctly even with zero
internet access**, and must self-heal the moment a window opens, with no manual step required.

## How a tile request actually flows

1. Client requests `GET /api/tiles/:style/:z/:x/:y.png?boundary=<layer>` (same-origin, through the
   Node backend — never talks to the CDN directly).
2. `getMaskedTile()` needs the boundary polygon first (`fetchBoundaryRings()`, cached from
   GeoServer WFS) to clip the tile to the real city/state shape, then calls `getRawTileBuffer()`
   for the actual imagery.
3. `getRawTileBuffer()` checks `server/tile-cache/<style>/<z>/<x>/<y>.png` on disk first (cache
   hit = filesystem read, no network). On a miss, `fetchAndCacheTile()` fetches from upstream
   (rotating mirrors, 5s per-mirror timeout, one retry on transient errors), writes to disk, and
   serves it.
4. **If upstream is unreachable** (offline, or the circuit breaker is open — see below):
   `getAncestorFallbackTile()` walks up the zoom pyramid to the nearest cached parent tile, crops
   the matching quadrant, and upscales it to 256x256. This is deliberately never written back to
   disk (it's a lossy stand-in, not truth) and gets a short 5-minute browser cache instead of the
   normal 30-day one. **This is what guarantees the map never shows a blank tile anywhere within
   the warmed extent, online or offline.**

## The circuit breaker

After 5 consecutive real upstream failures, `fetchAndCacheTile()` stops attempting new upstream
fetches for 5 minutes and goes straight to the ancestor fallback — otherwise every uncached-tile
request during an outage would pay the full ~30s mirror-timeout cost before falling back. A single
successful fetch (e.g. from the connectivity watchdog's probe) closes the breaker immediately.

## Cache warming (`cacheWarmer.js`)

`startCacheWarmer()` (called from `server/src/app.js`) runs once at server boot:

1. `warmAllCaches()` — walks every zoom level shallow-to-deep across **every city simultaneously**
   (not city-by-city) so the overview level is ready everywhere early, not just for city #1.
   UP-wide: z6-11. Cities: z11-16 for GWC layers, and per-style deeper for basemaps
   (`STYLE_WARM_MAX_ZOOM`: osm 17, positron/toner 16, topo/satellite/labels to their full client
   max — these three are warmed to 100% completeness since imagery blur is where the ancestor
   fallback is most noticeable). Past z15, only tiles that actually intersect the city's real
   boundary *polygon* (not its bounding rectangle) are fetched (`tileIntersectsRings`).
2. On completion, `exportAllMbtiles()` runs automatically (see below) — unless
   `TILE_MBTILES_EXPORT=0`.
3. If the pass had any failures (partial/no internet), `scheduleConnectivityWatchdog()` starts: a
   timer (`TILE_WARM_RECHECK_MINUTES`, default 10) that probes upstream connectivity and, the
   moment it succeeds, re-runs the full warm pass (cheap — already-cached tiles are millisecond
   stat-hits, so it only fetches what's still missing) and re-exports MBTiles. Stops polling once
   a pass completes with zero failures.
4. Separately, a 45-minute timer re-warms **only** GWC layers (road/zone/ward — real editable GIS
   data, 1-hour TTL) — basemap tiles are never re-fetched on a timer, they're eternal.

**Env vars** (all optional, sane defaults):
| Var | Default | Purpose |
|---|---|---|
| `TILE_WARM_CITY_MAX_ZOOM` | 16 | City GWC zoom ceiling. +1 level ≈ 4x tiles/time — measured z16 pass: 285k tiles / ~5.2h. |
| `TILE_WARM_UP_MAX_ZOOM` | 11 | UP-wide zoom ceiling. |
| `TILE_WARM_MAX_OSM` / `_POSITRON` / `_TONER` / `_TOPO` / `_SATELLITE` / `_LABELS` | 17/16/16/17/18/18 | Per-style basemap deep-zoom ceiling. |
| `TILE_WARM_RECHECK_MINUTES` | 10 | Connectivity watchdog poll interval. |
| `TILE_CACHE_CAP_GB` | 5 | Disk cache eviction cap (`tiles.js`) — raise this if you raise the zoom ceilings above, or the hourly eviction sweep will evict tiles the warmer just fetched. |
| `TILE_MBTILES_EXPORT` | (unset = on) | Set to `0` to disable auto-export (e.g. a dev machine where rewriting multi-hundred-MB archives on every restart is unwanted). |

## MBTiles export/restore (staging → production migration)

Purpose: warm the cache fully on a box that has internet access, package it into portable
per-style `.mbtiles` (standard SQLite tile format) files, hand-carry those to a server that has
none, and it's instantly fully warmed with zero upstream dependency.

- **Export**: automatic after every warm pass (see above), or manually: `node scripts/build-mbtiles.mjs [outDir]`.
  Writes `server/mbtiles/<style>.mbtiles`. Per-style staleness check (archive mtime vs. newest
  cached tile) skips a rewrite if nothing changed. Builds to a `.tmp` file and renames atomically
  — a crash mid-export never leaves a corrupt archive masquerading as a real one.
- **Restore** (run on the target server after copying the `.mbtiles` files over):
  `node scripts/restore-mbtiles.mjs [inDir]`. Unpacks into `server/tile-cache/`, skipping any
  tile already on disk (never clobbers something fresher).
- **MBTiles uses TMS row numbering** (Y-flipped, origin at the bottom); the app's disk cache and
  every XYZ tile source use origin-at-the-top. Both scripts handle the flip — if you ever touch
  this code, getting it wrong produces upside-down tiles, not an error.
- Raw (unmasked) per-style tiles only — the per-boundary masked derivatives are NOT included in
  the archive (they regenerate cheaply from the raw tiles + boundary polygon, no need to ship
  17 cities' worth of duplicate masked copies).

**Verify a full pass actually worked**: `node scripts/verify-basemaps.mjs [lon] [lat]` — fetches a
real tile at every zoom level of every style through the exact same code path a live request
takes (mirrors, retries, disk cache), and reports pass/fail per zoom. Defaults to Lucknow if no
coordinates given.

## Esri licensing — a live decision, not a technical constraint

`satellite`/`labels` are Esri World Imagery/Reference — commercially licensed imagery (Esri/Maxar/
Earthstar Geographics), not open-source like OSM/CARTO/OpenTopoMap. Long-term server-side caching
and MBTiles packaging of these two styles is (per Esri's standard ArcGIS Online terms) outside
what free/public access permits without a specific ArcGIS license. This system caches and packages
them anyway per an explicit decision already made for this deployment — attribution is included in
the MBTiles metadata ("Source: Esri, Maxar, Earthstar Geographics..."), but attribution does not
by itself grant the caching/redistribution right. If this project is ever audited, the clean fixes
are an ArcGIS Basic license (covers this use case cheaply) or swapping to a genuinely free
alternative (e.g. Sentinel-2 cloudless via EOX).

## Basemap failure toasts (client side)

`client/src/utils/basemapHealth.js` — `attachBasemapErrorNotifier()`, wired into both
`HomePage.js` and `MapContainer.jsx` for every base layer. Watches for a *burst* of
`tileloaderror` events (3 within 15s — a couple of isolated errors during fast panning is normal),
then makes one authenticated probe request to classify the failure via the server's `reason` field
(`server/src/routes/tiles.js`, `classifyUpstreamFailure()`):
- `"network"` (ECONNREFUSED/ECONNRESET/ETIMEDOUT/ENOTFOUND/timeout — never reached our own
  backend) → *"The `<style>` basemap is not available because the UPSDC network is not allowing
  this service. Please contact the UPSDC network team."*
- `"provider"` (backend reached the CDN, got an error status) → *"The open source basemap provider
  for `<style>` is facing an issue right now. Please use another basemap."*

5-minute cooldown per style so it doesn't nag repeatedly.

## Deploying this to a NEW environment (any OS)

1. `npm ci` at the repo root (workspaces) — `better-sqlite3` is a native module; `npm` fetches a
   prebuilt binary for the target OS/arch automatically via `prebuild-install` for common platforms
   (Windows x64, Linux x64/arm64, macOS). If a prebuilt binary isn't available for an unusual
   platform, `npm install` falls back to compiling from source, which needs Python 3 + a C++
   toolchain (`build-essential` on Debian/Ubuntu, or Visual Studio Build Tools on Windows) —
   normally not needed.
2. No new required env vars — `GEOSERVER_PROXY_TARGET` must already point at a scheme (http/https)
   that doesn't get redirected by whatever's in front of it (see the incident below for why this
   matters). Everything else in the table above has working defaults.
3. `server/tile-cache/` and `server/mbtiles/` are gitignored — they're generated at runtime, never
   committed. A fresh clone starts with an empty cache and warms itself at first boot if internet
   is available.
4. First boot on a machine with internet: cache-warmer runs automatically, no action needed.
5. First boot on a machine WITHOUT internet (the actual air-gapped target): `tile-cache/` stays
   empty, `getAncestorFallbackTile()` has nothing to fall back to yet either — basemaps genuinely
   won't render until either (a) internet becomes available (the connectivity watchdog picks it up
   automatically, no restart needed), or (b) you run `scripts/restore-mbtiles.mjs` against
   `.mbtiles` archives copied from a machine that already warmed.

## Real incident this system already caught (2026-07-08, pre-production)

Root cause chain, for reference if basemaps break again:
1. Load-balancer nginx started force-redirecting `http://.../geoserver/*` → `https://` (301).
2. `GEOSERVER_PROXY_TARGET` was still `http://`, and `fetchViaHttp()` rejected on any non-2xx
   status including redirects — every GeoServer-backed fetch (WFS boundary rings, GWC tiles)
   failed outright, breaking every basemap (all of them depend on the boundary-mask step).
3. Those failures **crashed the whole process**: `trackAbortableClient()` had
   `entry.promise.finally(decrementOnce)` — `.finally()` returns a new promise adopting the
   original's rejection, and that new promise was never awaited/caught anywhere, so Node treated
   it as an unhandled rejection on every failed request → PM2 crash-looped (56 restarts in 31
   minutes).

Both are now fixed: `fetchViaHttp()` follows redirects (`MAX_REDIRECTS = 5`), and the orphaned
`.finally()` promise gets a no-op `.catch()`. **The second fix matters independently of the
first** — any future burst of upstream failures (a real CDN outage, not just a redirect
misconfiguration) would have hit the exact same crash-loop before this fix, which is the opposite
of "graceful offline operation."

## Known gaps / not yet built

- Post-login "basemap cooking, please wait" loading gate — blocks app access until the warm pass
  confirms full tile coverage, shown once. Not started.
- No environment has completed a full deep-zoom warm pass + MBTiles export yet (as of this
  writing) — the timing estimates above are from a partial dev-machine run, not a verified
  production-scale completion.
