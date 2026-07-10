# URIDA Production Migration — Status Handoff

Read this first if you are a new Claude Code session picking up this migration on a
different machine (GeoServer host, DB host, or one of the new production servers).
This box (`/srv/urida/current`, a live staging/pre-production server) is NOT the
production target — it's where the App-server package below was built.

## Target topology (from `URIDA_Production_Server_Baseline_Report.xlsx`, local-only,
gitignored, sits at `/srv/urida/releases/20260504_151036/URIDA_Production_Server_Baseline_Report.xlsx`
on this box if you need the full detail — 13-sheet workbook, server inventory,
disk/network/risk register, install plan)

Three fresh RHEL 9.8 servers, VPN + SSH access only (no SCP/SFTP, no internet):

| Role | IP | What runs there |
|---|---|---|
| App | `192.168.190.112` | Nginx (reverse proxy) + this Node/Express app under PM2 |
| GeoServer | `192.168.190.110` | Tomcat 9 + GeoServer 2.26.x |
| DB | `192.168.190.111` | PostgreSQL 17 + PostGIS 3.6.x |

As of the baseline report (2026-06-15), **none of the three servers had disks
mounted, service users created, or software installed yet** — this is a from-
scratch bring-up, not a lift-and-shift. Check the Action_Tracker sheet in that
workbook for exact task status before assuming any of that is done.

DNS for the app once live: `Uridageomap.upsdc.gov.in`. SSL/public IP get attached
by UPSDC at the Edge/WAF layer later, once the App server is confirmed running
internally — this deployment ships plain HTTP on :80 for now.

Transfer method: everything is prepared on a source machine, hashed, then
physically carried/copied by hand — no direct network path for file transfer
into the target servers.

## What's done: the App server package

- Git tag `prod-app-2026-07-10-r2` (commit `533889c`) on this repo (branch `main`)
  is the exact source this package was built from.
- Final artifact: `/srv/urida/release-packages/urida-app-prod-2026-07-10-r2.tar.gz`
  (4.67 GB) + `/srv/urida/release-packages/CHECKSUMS.txt`
  (SHA256 `0e7e28406f732f370f262c30330352b5da298d9f6277abbb95fff220fb9f4f48`,
  MD5 `e849320b95af20e2f2cb9e4146f876cf`) — already downloaded to the user's
  Windows machine as of this handoff.
- Contents: server source (no `node_modules` — Ubuntu-built binaries aren't
  portable to RHEL 9's glibc, see below), an offline npm cache so `npm ci
  --offline` works with zero network on the target, a pre-built production
  `client/build/`, a ~5.2GB pre-warmed basemap tile cache (`mbtiles-export/`,
  osm/positron/toner/topo/satellite/labels), `.env.production.example`
  templates (NO real secrets), an Nginx config
  (`deploy/nginx/urida-app-server.conf`), an outbound whitelist
  (`deploy/OUTBOUND_WHITELIST.md`), and a bootstrap script
  (`deploy/bootstrap/app-server-bootstrap.sh`) that installs deps offline,
  verifies native modules, restores the tile cache, and starts PM2 — it
  deliberately does NOT touch Nginx; the user applies that config by hand
  while SSH'd into the App server. Full contents documented in the tarball's
  own `MANIFEST.txt`.
- Two real bugs were found and fixed during this session (both already in the
  packaged commit, see `git log` on commit `533889c` for full detail):
  1. Non-atomic cache writes (`fs.promises.writeFile`) left 0-byte corrupted
     files on disk-full, which every cache-hit check then served as valid
     forever. Fixed with a shared atomic-write-then-rename helper
     (`server/src/utils/atomicFile.js`) applied everywhere it was needed.
  2. Zone/Ward boundary layers silently failed to load on a page's first
     visit only (self-resolved on remount) — caused by a stale
     `getIsLowBandwidth()` gate in `MapContainer.jsx` misreading
     `navigator.connection.effectiveType` on a cold page load. Fixed by
     removing that gate for this specific (small, cheap) fetch.
- **Known risk still open, not yet resolved**: `better-sqlite3`'s native
  module was built on this box's Ubuntu 22.04 (glibc 2.35) and is NOT shipped
  in the package for that reason. The bootstrap script relies on
  `npm ci --offline` falling through to a local `node-gyp` compile on the
  RHEL 9 target — this REQUIRES `gcc-c++`, `make`, and `python3` to already
  be present in the App server's offline RPM repo. This has not been verified
  against an actual RHEL 9 machine — confirm this works before considering
  the App server deployment complete, and have a plan B (build node_modules
  on a real RHEL 9 box) if the compile fails.
- **Not yet written**: the full step-by-step deployment runbook for actually
  running the bootstrap script on the App server (pre-flight checklist against
  the baseline report's pending OS-level tasks, verification steps, rollback
  procedure). Ask for this explicitly if it wasn't done in a later session.

## What's NOT done — GeoServer

Out of scope for this session by design. Already has its own runbook and
tooling in this repo, written before this session:
- `docs/GEOSERVER_RHEL_MIGRATION.md` — the migration flow (backup on the
  current Ubuntu GeoServer host, restore on the new RHEL box, including the
  JNDI/Tomcat context gotcha and PostGIS JDBC override).
- `scripts/geoserver-backup-for-rhel.sh` and `scripts/geoserver-restore-on-rhel.sh`
  — the actual scripts. These need to run ON the GeoServer machine(s)
  (current Ubuntu host to create the backup, new RHEL 9 host to restore it),
  so this repo (or at least these two scripts + the runbook doc) needs to be
  physically present there — it won't be there automatically.
- The user considered this runbook "old" as of 2026-07-10 and may want it
  reviewed/refreshed before relying on it — wasn't re-audited this session.

## What's NOT done — Database

**No runbook or script exists yet for the actual PostgreSQL data migration**
(the 17 city schemas, DB name confirmed live as `nv_allnndb_app` on the
current box — confirm this is still accurate before assuming it). This is a
real gap, not an oversight to route around: standard approach would be
`pg_dump`/`pg_restore` (or `pg_dumpall` for globals) from the current DB host
to the new one, but nothing has been built, tested, or sized for this
project's actual data volume yet. Whoever picks this up needs to start closer
to scratch here — check `docs/DB_NOTES.md` for schema/tuning context first
(spatial indexing audit, PgBouncer usage on port 6432, `random_page_cost`/
`effective_cache_size`/`shared_buffers` tuning already applied to the CURRENT
db-primary — decide whether to replicate those settings on the new DB server
too).

## Env/secrets handling (applies to all three servers)

Real secrets (`DB_PASS`, `JWT_SECRET`, `KMC_API_KEY`, DB credentials for
GeoServer's JNDI datasource) are deliberately NOT in any package or repo file.
They get typed directly on each target machine over the interactive SSH
session, from the `.env.production.example` templates as a starting point.
`JWT_SECRET` specifically must be freshly generated for production, never
copied from the current staging `.env`.

## Outbound network whitelist

See `deploy/OUTBOUND_WHITELIST.md` inside the App package (or
`/srv/urida/releases/20260504_151036/deploy/OUTBOUND_WHITELIST.md` on this
box). Key point: basemap tiles (OSM/CartoDB/OpenTopoMap) are fetched
**server-side** by the App server itself, not just the browser — if that
egress isn't whitelisted and the pre-warmed cache runs out, basemaps will
silently stop working.
