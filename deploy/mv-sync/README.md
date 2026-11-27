# Materialized view sync job

Keeps the `<city>.mv_<city>_*` views current after data changes, including a table being renamed and new data
loaded under the old name. Each view is built in `mv_sync_build`, checked, then swapped in under the same name.
Application and GeoServer names do not change.

**Status:** see "Tested" below before switching any city on.

## Files

| File | Purpose |
|---|---|
| `mvsync.py` | the job and its commands |
| `rules.py`, `test_rules.py` | zone/ward SQL rule, scheduling, validation; unit tests |
| `capture.py` | writes `definitions/` from the live views (read-only), `--verify` checks them |
| `compare.py` | read-only check of every view against what the job would build; run before activating a city |
| `install.sh`, `uninstall.sh` | set up or remove the job on a database server |
| `sql/` | install, activate/deactivate a city, uninstall |
| `systemd/` | one-minute timer |
| `config.example.json` | settings |

## Behaviour

- Detects change from table identity, columns and write counters. No triggers.
- Waits until writes are quiet, with a maximum wait. `park_roads` is in the group with a night window.
- Refuses a new view that is empty, lost more than 20% of its rows, or has different columns. The old view stays.
- Never overwrites a view that someone else created or changed: it holds that view until `capture.py` is run
  again for that view (`--only schema.view`) and it is released. A view recreated by another database user
  also needs `sql/activate_city.sql` again, because the job can only replace views it owns.
- Never uses `CASCADE`. Skips the swap if the lock is not free within 5 seconds.
- Zone/ward: number first, text list as fallback, number only if the table has no `_text` columns.
  `encroachment_summary` keeps grouping by the text value while the column exists.
- Does nothing while `pg_dump` is connected.

## Clubs

| Group | Views | Query time, Ghaziabad | Built after |
|---|---|---|---|
| fast | street_light, encroachment_summary, underdeveloped_analysis, hospital, education, hotel | under 4 s each | 3 min quiet, at most 15 min |
| medium | atm_bank_roads, road_maintenance | about 20 s each | 10 min quiet, at most 60 min |
| heavy | park_roads | 147 s before the rewrite, about 1 s after | night window (can be revisited) |

One run handles one city's due views of one group. A view is due only when one of its own source tables changed.
The group is swapped in one transaction; if that fails, view by view, so only the busy or broken one waits.
A busy view is retried after `retry_seconds` without counting a failure. Anything waiting longer than
`overdue_seconds` goes first. Times for the other 16 cities are not measured.

## What runs where

Everything runs on **the database server**. Nothing is added to the application server or to GeoServer.

| On the database server | Created by `install.sh` |
|---|---|
| system user `mv_sync_job` (no login shell) | yes |
| `/opt/mv-sync` (job and captured view definitions), `/etc/mv-sync/config.json` | yes |
| 4 lines in `pg_hba.conf`, reload only | yes, original kept |
| database role `mv_sync_job`, schemas `mv_sync` and `mv_sync_build` | yes |
| systemd `mv-sync.service` and `mv-sync.timer` (every minute) | yes |
| GeoServer URL and `/etc/mv-sync/geoserver.credentials` for tile clearing | by hand, optional at first |

Needs: Linux with systemd, PostgreSQL 15 or newer with PostGIS, Python 3.9 or newer, 20 GB free.
The database must follow the layout `<city>.<city>_road_net` with views `<city>.mv_<city>_*`.

A separate machine that only reaches the database over the network is not supported by these scripts: the job
needs local `peer` login. The database server itself is the intended place.

## Install on a server

    git clone <this repository> && cd <repository>/deploy/mv-sync
    sudo bash install.sh --database NAME            # checks only
    sudo bash install.sh --database NAME --apply    # installs in observe mode

Definitions are captured from that server's own views, so the same steps work on another server.
The installer captures without GeoServer layer names, so no tile cache is cleared until they are added:

    cd /opt/mv-sync && sudo -u postgres python3 capture.py --local --database NAME         --geoserver <https url> --credentials /etc/mv-sync/geoserver.credentials

(run before switching any city on, after `sudo chown -R postgres definitions`; recapturing every view after the job
has rebuilt some is not advised, use `--only` then).
Observe mode changes no view; it only records `would_build` in `mv_sync.run_log`.

Remove: `sudo bash uninstall.sh --database NAME`.

## Switching a city on (separate, deliberate step)

1. A scheduled, restore-tested backup.
2. Change the application (below).
3. `sudo -u postgres python3 /opt/mv-sync/compare.py --local --city CITY`
4. `sudo -u postgres psql -d NAME -v city=CITY -f /opt/mv-sync/sql/activate_city.sql`
5. Set `mode = 'on'` in `mv_sync.control`, then `sudo -u mv_sync_job python3 /opt/mv-sync/mvsync.py rebuild CITY`.
   Without the rebuild an already stale view stays stale until its table changes again, because the job assumes
   a view it meets for the first time is current.

Commands: `mvsync.py status | pause [city] | resume [city] | release <view> | accept <view> | rebuild <city>`.
Undo for a city: `sql/deactivate_city.sql`.

## Application changes needed before `mode = 'on'`

- `server/src/roadNetwork.js`, route `/:cityCode/road-analysis/:amenityType` (used by the map): it creates the
  view when missing, with different columns, and refreshes it on `?refresh=true`. It should only read.
- `server/src/controllers/dssController.js`: the `ensure*View` functions create and refresh views, one of them
  inside a GET request. They should only read.

## Not covered

- GeoServer bounding boxes are not recalculated.
- Responses through the load balancer can stay cached for up to 10 minutes (60 minutes for `/geoserver/gwc/`).
- Alerts are only written to `mv_sync.run_log` and the service journal.
- The job needs an encrypted URL to GeoServer for tile cache clearing; otherwise requests stay queued.
- A new city or a new view is not created automatically.

## Tested

- Unit tests: `python3 test_rules.py` (33, also run by CI).
- All 153 views compared read-only with pre-production (`compare.py`, 2026-11-27): 137 equal to the live view,
  16 equal to their original SQL on current data (those live views are stale). None differs.
- Database scenarios: 88/88 passed on 2026-11-27 in a temporary copy of the Ghaziabad and Shahjahanpur schemas
  (since removed), with the job running under its own role. Covers clubs and their order, data of all 18 views
  against the original SQL, empty table, large row drop, busy and undroppable views inside a club, leftovers,
  dropped and manually changed views, pause, `pg_dump`, isolation between cities, a renamed table with new data,
  a missing table, `rebuild`, building while another session keeps writing (362 updates, slowest 17 ms),
  deactivation and uninstall.
- `capture.py --only` for two views, and refusal of an unknown view name.
- **Not tested:** GeoServer tile cache clearing and layers after a swap, the systemd units, the OS user and the
  `pg_hba` lines on a real server.

### Running the database scenarios

On a database server, from a folder holding this directory with `definitions/`:

    bash tests_db/setup_testdb.sh SOURCE_DB ghaziabad shahjahanpur
    sudo -u postgres python3 tests_db/scenarios.py ghaziabad shahjahanpur
    bash tests_db/teardown_testdb.sh

The source database is only read. The test creates the role `mv_sync_job`; teardown removes it. Do not run it
where the job is installed. A run takes about 20 minutes.

## Speed rewrites (`rules.optimise`, applied when building)

- `road_maintenance`: inlined CTEs repeated `to_jsonb` thousands of times per row; they are now `MATERIALIZED`
  (Shahjahanpur 179 s to 11 s).
- `*_roads`: the join transforms geometry, so no spatial index was used; a `&&` / `ST_Expand` prefilter on the
  stored geometry is added when all source tables are SRID 4326 (Ghaziabad `park_roads` 146 s to 0.9 s).
- Query times on pre-production afterwards: largest is Lucknow `road_maintenance`, about 98 s. The group settings
  in `config.example.json` were chosen before these rewrites and can be revisited.
