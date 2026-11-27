#!/usr/bin/env python3
"""Materialized view sync job: detect change, build aside, validate, swap, clear tiles.

Usage: mvsync.py [--config FILE] tick | status | pause [CITY] | resume [CITY]
                 | release VIEW | accept VIEW | rebuild CITY
VIEW is schema.name. Standard library only; talks to PostgreSQL through psql.

One "tick" (run every minute by a timer):
  1. stop if the mode is off or a pg_dump is connected
  2. detect: for every view, a signature of its source tables (identity, columns, write counters)
     and its definition file; note when it changed, and hold views someone changed by hand
  3. pick the views that are due (quiet long enough, or waited too long)
  4. take ONE club (one city, one speed group): build each view in mv_sync_build, check it,
     then swap the good ones under their original names
  5. clear GeoServer tile caches for swapped layers, raise alerts, record the run
In "observe" mode steps 4 and 5 only log what would have happened.
The job never writes to a source table and never drops anything with CASCADE.
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

import rules

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = "mv_sync_build"


class SqlError(Exception):
    pass


def lit(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


class Db:
    def __init__(self, cfg):
        # direct PostgreSQL connection; never through a transaction pooler
        self.cmd = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", cfg["database"]]
        if cfg.get("host"):
            self.cmd += ["-h", cfg["host"]]
        self.cmd += ["-p", str(cfg.get("port", 5432))]
        if cfg.get("user"):
            self.cmd += ["-U", cfg["user"]]

    def run(self, sql, single_transaction=False):
        cmd = self.cmd + (["-1"] if single_transaction else []) + ["-f", "-"]
        env = dict(os.environ, PGAPPNAME="mv_sync")
        p = subprocess.run(cmd, input=sql, capture_output=True, text=True, env=env)
        if p.returncode != 0:
            raise SqlError(p.stderr.strip()[-1500:])
        return p.stdout.strip()

    def json(self, query):
        out = self.run(f"SELECT coalesce(json_agg(q), '[]') FROM ({query}) q;")
        return json.loads(out)


class Job:
    def __init__(self, cfg):
        self.cfg = cfg
        self.db = Db(cfg)
        self.defs = os.path.join(HERE, cfg.get("definitions", "definitions"))
        with open(os.path.join(self.defs, "manifest.json"), encoding="utf-8") as f:
            self.views = {v["view"]: v for v in json.load(f)["views"]}
        for v in self.views.values():
            rules.ident(v["city"])
            rules.ident(v["name"])
            for s in v["sources"]:
                for part in s.split("."):
                    rules.ident(part)

    # ------------------------------------------------------------ helpers
    def log(self, view, action, detail="", ms=None):
        print(f"{action} {view or '-'} {detail}", flush=True)
        self.db.run("INSERT INTO mv_sync.run_log(view_name, action, detail, ms) VALUES "
                    f"({lit(view)}, {lit(action)}, {lit(detail[:2000])}, {lit(ms)});")

    def definition(self, view, variant):
        with open(os.path.join(self.defs, f"{view}.{variant}.sql"), encoding="utf-8") as f:
            return f.read().strip().rstrip(";")

    def rule(self, view):
        return self.cfg["groups"][self.views[view]["group"]]

    def save(self, view, state):
        cols = ["seen_sig", "built_sig", "rejected_sig", "logged_sig", "first_change_at", "last_change_at",
                "last_success_at", "fail_count", "held", "held_reason", "accept_rows", "expected_oid", "retry_after"]
        values = dict({"fail_count": 0, "held": False, "accept_rows": False}, **state)
        names = ", ".join(cols)
        data = ", ".join(lit(values.get(c)) for c in cols)
        updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols)
        self.db.run(f"INSERT INTO mv_sync.view_state(view_name, city, {names}) VALUES "
                    f"({lit(view)}, {lit(self.views[view]['city'])}, {data}) "
                    f"ON CONFLICT (view_name) DO UPDATE SET {updates};")

    def states(self):
        return {r["view_name"]: r for r in self.db.json("SELECT * FROM mv_sync.view_state")}

    # ------------------------------------------------------------ detection
    def source_facts(self):
        sources = sorted({s for v in self.views.values() for s in v["sources"]})
        values = ", ".join(f"({lit(s)})" for s in sources)
        rows = self.db.json(f"""
            SELECT s.src, c.oid::bigint AS oid, pg_relation_filenode(c.oid) AS node,
                   pg_stat_get_tuples_inserted(c.oid) AS ins,
                   pg_stat_get_tuples_updated(c.oid) AS upd,
                   pg_stat_get_tuples_deleted(c.oid) AS del,
                   (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
                      FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
                   EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
                            AND a.attname = 'zone_no_text') AS zt,
                   EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
                            AND a.attname = 'ward_no_text') AS wt
              FROM (VALUES {values}) s(src)
              LEFT JOIN pg_class c ON c.oid = to_regclass(s.src)""")
        return {r["src"]: r for r in rows}

    def view_dependencies(self):
        rows = self.db.json("""
            SELECT n.nspname || '.' || c.relname AS view, array_agg(DISTINCT d.refobjid::bigint) AS deps
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_rewrite r ON r.ev_class = c.oid
              JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                              AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> c.oid
             WHERE c.relkind = 'm' GROUP BY 1""")
        return {r["view"]: set(r["deps"]) for r in rows}

    def view_identity(self):
        """Live object id and definition hash of every materialized view."""
        rows = self.db.run("SET search_path = pg_catalog; SELECT coalesce(json_agg(q), '[]') FROM ("
                           "SELECT n.nspname || '.' || c.relname AS view, c.oid::bigint AS oid, "
                           "md5(pg_get_viewdef(c.oid)) AS md5 FROM pg_class c "
                           "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'm') q;")
        return {r["view"]: r for r in json.loads(rows)}

    def variant(self, view, facts):
        road = f"{self.views[view]['city']}.{self.views[view]['city']}_road_net"
        zt, wt = facts[road]["zt"], facts[road]["wt"]
        if zt != wt:
            raise SqlError(f"{road} has only one of zone_no_text / ward_no_text")
        return "text" if zt else "plain"

    def signature(self, view, facts):
        """Returns (signature, missing_sources)."""
        v = self.views[view]
        missing = [s for s in v["sources"] if facts[s]["oid"] is None]
        parts = [json.dumps(facts[s], sort_keys=True) for s in sorted(v["sources"])]
        if not missing:
            parts.append(self.definition(view, self.variant(view, facts)))
        return hashlib.sha256("\n".join(parts).encode()).hexdigest(), missing

    def detect(self, now):
        facts, deps, states = self.source_facts(), self.view_dependencies(), self.states()
        live = self.view_identity()
        found = {}
        for view, v in self.views.items():
            try:
                sig, missing = self.signature(view, facts)
            except (SqlError, OSError, ValueError) as e:  # e.g. a definition file is missing
                self.log(view, "alert", str(e))
                continue
            expected = {facts[s]["oid"] for s in v["sources"]}
            repoint = view not in deps or deps[view] != expected
            state = rules.observe(states.get(view, {}), sig, repoint and not missing, now)
            now_view = live.get(view, {})
            reason = rules.outside_change(state.get("expected_oid"), now_view.get("oid"),
                                          v["live_md5"], now_view.get("md5"))
            if reason:
                state.update(held=True, held_reason=reason)
            elif state.get("expected_oid") is None:
                state["expected_oid"] = now_view.get("oid")
            if state != states.get(view):
                self.save(view, state)
            found[view] = {"sig": sig, "repoint": repoint, "missing": missing, "state": state}
        return facts, found

    # ------------------------------------------------------------ build and swap
    def clean_build_schema(self):
        self.db.run(f"""DO $$ DECLARE r record; BEGIN
            FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname = '{BUILD}' LOOP
              EXECUTE format('DROP MATERIALIZED VIEW {BUILD}.%I', r.matviewname);
            END LOOP; END $$;""")

    def columns(self, relation):
        rows = self.db.json("SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a "
                            f"WHERE a.attrelid = to_regclass({lit(relation)}) AND a.attnum > 0 "
                            "AND NOT a.attisdropped ORDER BY a.attnum")
        return [[r["n"], r["t"]] for r in rows]

    def index_sql(self, view):
        """Index statements for the new object: taken from the live view, else from the manifest."""
        v = self.views[view]
        rows = self.db.json("SELECT pg_get_indexdef(indexrelid) AS d FROM pg_index "
                            f"WHERE indrelid = to_regclass({lit(view)})")
        defs = [r["d"] for r in rows] or v["indexes"]
        out = []
        for d in defs:
            old = f" ON {view} "
            if old not in d:
                raise SqlError(f"unexpected index definition: {d}")
            out.append(d.replace(old, f" ON {BUILD}.{v['name']} ") + ";")
        return out

    def row_hash(self, relation):
        return self.db.run(f"SELECT count(*) || ':' || coalesce(md5(string_agg(h, '' ORDER BY h)), '') "
                           f"FROM (SELECT md5(x::text) h FROM {relation} x) s;")

    def stored_in_degrees(self, sources):
        """True if every source table's geom column is declared as SRID 4326."""
        names = ", ".join(lit(s) for s in sources)
        return self.db.run("SELECT count(*) FROM public.geometry_columns WHERE srid = 4326 AND "
                           "f_geometry_column = 'geom' AND f_table_schema || '.' || f_table_name "
                           f"IN ({names});") == str(len(sources))

    def build(self, view, facts):
        """Build into the build schema. Returns 'swap', 'same' or raises. Rejections raise Rejected."""
        v = self.views[view]
        road = f"{v['city']}.{v['city']}_road_net"
        # a view recreated by another database user cannot be replaced; say so before spending time on a build
        if self.db.run(f"SELECT pg_get_userbyid(relowner) <> current_user FROM pg_class "
                       f"WHERE oid = to_regclass({lit(view)});") == "t":
            raise SqlError("view is owned by another user (recreated by hand?): run capture.py --only for it, "
                           "then activate_city.sql, then release")
        for src in v["sources"]:
            if src == road and self.db.run(f"SELECT EXISTS (SELECT 1 FROM {src});") != "t":
                raise Rejected(f"source {src} is empty")
        definition = self.definition(view, self.variant(view, facts))
        kind = v["name"][len(f"mv_{v['city']}_"):]
        definition = rules.optimise(definition, kind, kind.endswith("_roads") and
                                    self.stored_in_degrees(v["sources"]))
        new = f"{BUILD}.{v['name']}"
        script = [f"SET statement_timeout = {lit(self.cfg['build_timeout'])};", "SET lock_timeout = '30s';",
                  f"CREATE MATERIALIZED VIEW {new} AS\n{definition};"]
        script += self.index_sql(view) + [f"ANALYZE {new};"]
        self.db.run("\n".join(script), single_transaction=True)

        if self.db.run(f"SELECT to_regclass({lit(view)}) IS NOT NULL;") != "t":
            return "swap"
        problem = rules.check_columns(self.columns(view), self.columns(new))
        if problem:
            raise Rejected(problem)
        old_hash, new_hash = self.row_hash(view), self.row_hash(new)
        state = self.states().get(view, {})
        if not state.get("accept_rows"):
            problem = rules.check_rows(int(old_hash.split(":")[0]), int(new_hash.split(":")[0]),
                                       self.cfg["max_row_drop"])
            if problem:
                raise Rejected(problem)
        deps = self.view_dependencies().get(view, set())
        correct_tables = deps == {facts[s]["oid"] for s in v["sources"]}
        return "same" if old_hash == new_hash and correct_tables else "swap"

    def swap_sql(self, view, expected_oid=None):
        v = self.views[view]
        name, city = v["name"], v["city"]
        fallback = "".join(f"EXECUTE {lit(f'GRANT {p} ON {BUILD}.{name} TO {g}')};" for g, p in v["grants"])
        return f"""
DO $swap$
DECLARE old regclass := to_regclass('{view}'); g record;
BEGIN
  IF to_regclass('{BUILD}.{name}') IS NULL THEN RAISE EXCEPTION 'built view missing: {name}'; END IF;
  IF old IS NOT NULL AND old::oid::bigint IS DISTINCT FROM {lit(expected_oid)} THEN
    RAISE EXCEPTION 'view {view} was changed outside the job, not swapping';
  END IF;
  FOR g IN SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
            WHERE c.oid = '{BUILD}.{name}'::regclass AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON {BUILD}.{name} FROM %s',
                   CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
  IF old IS NULL THEN
    {fallback or 'NULL;'}
  ELSE
    -- copy the live grants so manual permission changes survive the swap
    FOR g IN SELECT a.grantee, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = old AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN ('postgres', current_user)) LOOP
      EXECUTE format('GRANT %s ON {BUILD}.{name} TO %s', g.privilege_type,
                     CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
    END LOOP;
    EXECUTE 'DROP MATERIALIZED VIEW {view}';  -- never CASCADE
  END IF;
  EXECUTE 'ALTER MATERIALIZED VIEW {BUILD}.{name} SET SCHEMA {city}';
END $swap$;
""" + "".join(f"INSERT INTO mv_sync.cache_queue(layer) SELECT {lit(layer)} WHERE NOT EXISTS "
              f"(SELECT 1 FROM mv_sync.cache_queue WHERE layer = {lit(layer)});\n" for layer in v["layers"])

    def fail(self, view, state, sig, error, rejected):
        state["fail_count"] = (state.get("fail_count") or 0) + 1
        # wait longer after each failure instead of rebuilding every minute
        state["retry_after"] = time.time() + self.cfg["retry_seconds"] * state["fail_count"]
        if rejected:
            state["retry_after"] = None  # a rejection already waits for the source to change
            state["rejected_sig"] = sig
            state["held_reason"] = error[:500]
        if state["fail_count"] >= self.cfg["max_failures"]:
            state["held"] = True
            state["held_reason"] = error[:500]
        self.save(view, state)
        self.log(view, "rejected" if rejected else "failed", error)

    def run_swap(self, views, found):
        """Swap the given built views in one transaction: all of them or none."""
        swaps = [self.swap_sql(v, found[v]["state"].get("expected_oid")) for v in views]
        self.db.run("BEGIN;\nSET LOCAL lock_timeout = '5s';\n" + "".join(swaps) + "COMMIT;\n")

    def swap_club(self, views, found):
        """Swap a club together; if that fails, one by one. Returns the views that were swapped.

        The fallback keeps one busy or broken view from blocking, or being blamed on, the others.
        """
        try:
            self.run_swap(views, found)
            swapped = list(views)
        except SqlError as first_error:
            swapped = []
            for view in views:
                try:
                    if len(views) == 1:
                        raise first_error
                    self.run_swap([view], found)
                    swapped.append(view)
                except SqlError as e:
                    if "lock timeout" in str(e):
                        # busy is not a fault: try again later without counting a failure
                        state = found[view]["state"]
                        state["retry_after"] = time.time() + self.cfg["retry_seconds"]
                        self.save(view, state)
                        self.log(view, "retry_later", "view busy, swap skipped")
                    else:
                        self.fail(view, found[view]["state"], found[view]["sig"], str(e), False)
        for view in swapped:
            self.log(view, "swapped")
        return swapped

    def process_club(self, views, facts, found):
        """Build each view of the club aside, check it, then swap the good ones."""
        self.clean_build_schema()
        ready, same = [], []
        for view in views:
            started = time.time()
            try:
                result = self.build(view, facts)
            except Rejected as e:
                self.fail(view, found[view]["state"], found[view]["sig"], str(e), True)
                continue
            except Exception as e:  # anything else must not stop the other views
                self.fail(view, found[view]["state"], found[view]["sig"], str(e), False)
                continue
            (ready if result == "swap" else same).append(view)
            self.log(view, "built", result, int((time.time() - started) * 1000))
        if ready:
            ready = self.swap_club(ready, found)
        # the signature stored is the one taken before the build: later changes are caught next time
        live = self.view_identity()
        for view in ready + same:
            state = dict(found[view]["state"], expected_oid=live.get(view, {}).get("oid"), built_sig=found[view]["sig"], first_change_at=None,
                         last_success_at=time.time(), fail_count=0, held=False, held_reason=None,
                         rejected_sig=None, accept_rows=False, retry_after=None)
            self.save(view, state)
        self.clean_build_schema()

    # ------------------------------------------------------------ tile cache
    def flush_cache(self):
        geo = self.cfg.get("geoserver") or {}
        queue = self.db.json("SELECT id, layer FROM mv_sync.cache_queue ORDER BY id LIMIT 100")
        if not queue:
            return
        url = (geo.get("url") or "").rstrip("/")
        if not (url.startswith("https://") or url.startswith("http://127.0.0.1")):
            self.log(None, "alert", f"{len(queue)} tile caches waiting: no encrypted GeoServer URL configured")
            return
        with open(geo["credentials_file"], encoding="utf-8") as f:
            user_pass = f.read().strip()
        auth = "Basic " + base64.b64encode(user_pass.encode()).decode()
        for row in queue:
            body = f"<truncateLayer><layerName>{row['layer']}</layerName></truncateLayer>".encode()
            req = urllib.request.Request(url + "/gwc/rest/masstruncate", data=body, method="POST",
                                         headers={"Authorization": auth, "Content-Type": "text/xml"})
            try:
                with urllib.request.urlopen(req, timeout=60):
                    pass
            except OSError as e:
                # keep it queued, but do not let one layer block the others
                self.log(None, "alert", f"tile cache clear failed for {row['layer']}: {e}")
                continue
            self.db.run(f"DELETE FROM mv_sync.cache_queue WHERE id = {int(row['id'])};")

    # ------------------------------------------------------------ main loop
    def alerts(self, found, now):
        for view, f in found.items():
            s = f["state"]
            if f["missing"]:
                problem = f"source table missing: {', '.join(f['missing'])}"
            elif s.get("held"):
                problem = f"held: {s.get('held_reason')}"
            elif (rules.is_dirty(s, f["sig"], f["repoint"]) and s.get("first_change_at") is not None
                  and not self.rule(view).get("window")
                  and now - s["first_change_at"] > self.cfg["stale_alert_seconds"]):
                problem = "change not applied for too long"
            else:
                continue
            recent = self.db.run("SELECT EXISTS (SELECT 1 FROM mv_sync.run_log WHERE action = 'alert' AND "
                                 f"view_name = {lit(view)} AND at > now() - interval '1 hour');")
            if recent != "t":
                self.log(view, "alert", problem)

    def tick(self):
        mode = self.db.run("SELECT mode FROM mv_sync.control;")
        if mode == "off":
            return
        if self.db.run("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name LIKE 'pg_dump%');") == "t":
            return
        now = time.time()
        facts, found = self.detect(now)
        paused = {r["city"] for r in self.db.json("SELECT city FROM mv_sync.paused_city")}
        enabled = {r["city"] for r in self.db.json("SELECT city FROM mv_sync.enabled_city")}
        due = [view for view, f in found.items()
               if not f["missing"] and rules.is_due(f["state"], f["sig"], f["repoint"], self.rule(view), now)]
        if mode == "observe":
            for view in due:
                state = found[view]["state"]
                if state.get("logged_sig") != found[view]["sig"]:
                    state["logged_sig"] = found[view]["sig"]
                    self.save(view, state)
                    self.log(view, "would_build", "repoint" if found[view]["repoint"] else "data changed")
        else:
            due = [v for v in due if self.views[v]["city"] in enabled - paused]
            if due:
                free = shutil.disk_usage(self.cfg.get("disk_path", "/")).free / 1024 ** 3
                if free < self.cfg["min_free_gb"]:
                    self.log(None, "alert", f"only {free:.0f} GB free, not building")
                else:
                    # one club (one city, one speed group) per run; see "clubs" in rules.py
                    club = rules.choose_club(
                        [(v, self.views[v]["city"], self.views[v]["group"], found[v]["state"].get("first_change_at"))
                         for v in due], now, self.cfg["overdue_seconds"])
                    self.process_club(club[2], facts, found)
            self.flush_cache()
        self.alerts(found, now)
        self.db.run("UPDATE mv_sync.control SET last_run_at = now();")


class Rejected(Exception):
    pass


def single_instance(path):
    import fcntl  # Linux only, where the job runs
    handle = open(path, "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return None
    return handle


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="/etc/mv-sync/config.json")
    ap.add_argument("command", choices=["tick", "status", "pause", "resume", "release", "accept", "rebuild"])
    ap.add_argument("target", nargs="?")
    a = ap.parse_args(argv)
    with open(a.config, encoding="utf-8") as f:
        job = Job(json.load(f))
    if a.command == "tick":
        lock = single_instance(job.cfg.get("lock_file", "/run/mv-sync/lock"))
        if lock:
            job.tick()
    elif a.command == "status":
        print(job.db.run("SELECT 'mode=' || mode || ' last_run=' || coalesce(last_run_at::text, 'never') "
                         "FROM mv_sync.control;"))
        print(job.db.run("SELECT view_name, CASE WHEN held THEN 'HELD ' || coalesce(held_reason, '') "
                         "WHEN built_sig IS DISTINCT FROM seen_sig THEN 'pending' ELSE 'ok' END "
                         "FROM mv_sync.view_state ORDER BY 1;"))
    elif a.command in ("pause", "resume"):
        if a.target:
            sql = (f"INSERT INTO mv_sync.paused_city VALUES ({lit(a.target)}) ON CONFLICT DO NOTHING;"
                   if a.command == "pause" else f"DELETE FROM mv_sync.paused_city WHERE city = {lit(a.target)};")
        else:
            sql = f"UPDATE mv_sync.control SET mode = {lit('off' if a.command == 'pause' else 'observe')};"
        job.db.run(sql)
        if not a.target and a.command == "resume":
            print("mode is now observe; set mode = 'on' in mv_sync.control to build again")
    else:
        if not a.target:
            ap.error("target required")
        column = "city" if a.command == "rebuild" else "view_name"
        change = {"release": "held = false, fail_count = 0, rejected_sig = NULL, retry_after = NULL, "
                             "expected_oid = NULL",
                  "accept": "held = false, fail_count = 0, rejected_sig = NULL, retry_after = NULL, accept_rows = true",
                  "rebuild": "built_sig = NULL, rejected_sig = NULL, retry_after = NULL, "
                             "first_change_at = 0, last_change_at = 0"}
        job.db.run(f"UPDATE mv_sync.view_state SET {change[a.command]} WHERE {column} = {lit(a.target)};")


if __name__ == "__main__":
    sys.exit(main())
