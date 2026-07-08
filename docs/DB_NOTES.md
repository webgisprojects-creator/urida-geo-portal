# Database Notes for URIDA Production

## 2026-07-05 — Spatial indexing audit + safe settings tuning

Context: general portal slowness investigation traced most of the problem
to the application layer (missing local caching, request concurrency —
see server/src/routes/tiles.js, wfsCache.js, utils/concurrencyLimiter.js).
While auditing whether anything on the DB side also contributed, ran a
read-only check against `pg_indexes` / `geometry_columns` and found 99
geometry columns (across all 17 cities) with no spatial index — all in the
`mv_<city>_atm_bank_roads` / `education_roads` / `hospital_roads` /
`hotel_roads` / `park_roads` proximity-analysis materialized views, plus
`mv_<city>_street_light` and `mv_<city>_underdeveloped_analysis`, and
`kanpur_ward_boundary_mobile`. The primary road/boundary/chainage tables
that carry the bulk of map traffic already had proper GIST indexes — this
was not the cause of the general slowness, but would have caused full
table scans the moment anyone opened the Street Light / Underdeveloped
Zones / amenities-near-roads analysis panels.

### Machine facts confirmed before touching anything (via SSH to db-primary)
- 8 CPU cores, 30GB RAM (28GB available), **SSD storage** (`lsblk` rota=0),
  858GB free disk, load average 0.00 at time of change.
- PostgreSQL 17.9, PostGIS 3.6.2.
- App connects via PgBouncer on port 6432, not directly to Postgres.

### What was changed
All actions used `CREATE INDEX CONCURRENTLY IF NOT EXISTS` — this never
locks a table against reads or writes while building, and is safe to
re-run (skips anything that already exists). Verified afterward: **zero
invalid/broken indexes**, zero failed statements.

1. **99 net-new GIST indexes** on the geometry columns listed above
   (confirmed before/after: 532 → 631 GIST indexes in the database).
2. **B-tree indexes on non-geometry columns actually filtered by the app**
   — confirmed by grepping `server/src/roadNetwork.js` and
   `server/src/routes/chainage.js` for real WHERE-clause usage:
   `zone_no`, `ward_no`, `condition`, `category`, `material`, `ownership`,
   `cus_class`, `road_id`, `gis_id`. Applied to every table in the database
   with a `road_id` column — this turned out to include not just each
   city's live `<city>_road_net` table but also `_archive`, `_new`, and
   `_reshape` variants that exist per city (worth a look at some point —
   if those are genuinely stale/unused copies, they're just extra disk
   space and index-maintenance overhead now, not a correctness problem).
3. **Two dynamic settings, applied via `ALTER SYSTEM` + `pg_reload_conf()`
   (no restart, no downtime)**:
   - `random_page_cost`: `4` → `1.1`. `4` is Postgres's historical
     default, tuned for spinning-disk random-access cost; on confirmed
     SSD storage it overestimates random I/O cost and biases the planner
     away from using indexes even when they'd be faster. `1.1` is the
     standard recommendation for SSD-backed Postgres.
   - `effective_cache_size`: `12GB` → `20GB`. This is a planner hint (not
     a memory allocation) for how much RAM the OS can use for disk
     caching; the host has 28GB available, so 12GB was underselling the
     planner on how much can be cached, making it undervalue index scans
     for larger result sets.

### Update — `shared_buffers` change (later in the same engagement)
Originally deferred (see below) since it requires a restart, not just a
reload. Explicitly authorized afterward, applied, and verified:
- `shared_buffers`: `4GB` → `8GB` (~25% of the host's 30GB RAM, the standard
  guideline) via `ALTER SYSTEM SET shared_buffers = '8GB'`.
- `systemctl restart postgresql@17-main`, confirmed back up and accepting
  connections, `pgbouncer` confirmed still active, app confirmed working
  end-to-end after the restart (single coherent action, no partial state).
- Live-verified: `SHOW shared_buffers` on `db-primary` returns `8GB`.

### Deliberately NOT changed (at the time of the initial audit)
- **`shared_buffers`** — see the update above; this was the one setting in
  this audit that required a restart, so it was intentionally held back for
  an explicit maintenance-window decision rather than bundled with the
  restart-free changes above.
- No table schemas, columns, or data were altered. No rows were touched.
  Nothing here can cause data loss — indexes are purely additive
  structures, and the two settings changes are planner/cache hints, not
  storage-affecting parameters.

### How to verify or roll back
```sql
-- Re-check for any invalid indexes (should be 0):
SELECT n.nspname, c.relname FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.indisvalid = false;

-- Revert the two settings if ever needed:
ALTER SYSTEM SET random_page_cost = 4;
ALTER SYSTEM SET effective_cache_size = '12GB';
SELECT pg_reload_conf();

-- Any specific index can be dropped concurrently (safe, no table lock):
DROP INDEX CONCURRENTLY IF EXISTS "<schema>"."<index_name>";
```

## 2026-07-04 — GeoServer chainage style: decision still pending

Not yet applied — documented here so it isn't lost. `Chainage:Kanpur_interpolatedpoints`'s
default style is currently `Kanpur_Chainage` (yellow points, raw
unformatted distance labels). A better, already-registered style exists
in the same workspace — `chainage_distance_label` (red points, distance
formatted to 2 decimals, larger font) — but it was never actually wired
up as the layer's default, and the client never passes an explicit
`STYLES=` param either, so it's sitting unused. There's also a dead,
unregistered duplicate (`knp_chain_label.sld`) in the *global* styles
folder with no `.xml` catalog sidecar — GeoServer doesn't even know it
exists; harmless, just clutter.

Pending decision: switch the layer's default style to
`chainage_distance_label`, and/or delete the orphaned global SLD.
