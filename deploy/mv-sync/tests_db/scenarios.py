#!/usr/bin/env python3
"""End-to-end scenarios of the sync job against a throwaway database. Never run against real data.

Prepare with setup_testdb.sh, then run as the OS user postgres, from a folder that also holds
definitions/ (written by capture.py):
    python3 tests_db/scenarios.py ghaziabad shahjahanpur

The job itself runs with only the rights of mv_sync_job; the test's own changes run as postgres.
The first city is the one activated by the setup; the second one is used to prove isolation.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import mvsync  # noqa: E402

DB = "mv_sync_test"
C, OTHER = sys.argv[1], sys.argv[2]
ROAD = f"{C}.{C}_road_net"


def view(kind, city=C):
    return f"{city}.mv_{city}_{kind}"


SL, HOSP, HOTEL = view("street_light"), view("hospital_roads"), view("hotel_roads")
results = []
ADMIN_ENV = {k: v for k, v in os.environ.items() if k != "PGOPTIONS"}


# ------------------------------------------------------------------ helpers
def admin(sql):
    p = subprocess.run(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-p", "5432", "-d", DB, "-f", "-"],
                       input=sql, capture_output=True, text=True, env=ADMIN_ENV)
    if p.returncode:
        raise RuntimeError(p.stderr[-800:])
    return p.stdout.strip()


def background(sql, app="psql"):
    proc = subprocess.Popen(["psql", "-X", "-q", "-d", DB, "-c", sql], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=dict(ADMIN_ENV, PGAPPNAME=app))
    time.sleep(1)
    return proc


def stop(proc, marker):
    proc.terminate()
    proc.wait()
    admin(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' "
          f"and pid<>pg_backend_pid() and query like '%{marker}%';")


def check(name, ok, info=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -> {str(info)[:900]}"), flush=True)


def section(title):
    print(f"== {title}", flush=True)


def meta(name):
    return json.loads(admin(f"""select json_build_object('oid', c.oid::bigint, 'owner', pg_get_userbyid(c.relowner),
      'acl', (select json_agg(distinct (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)
                      || ':' || a.privilege_type) from aclexplode(c.relacl) a
              where a.grantee<>c.relowner and (a.grantee=0 or pg_get_userbyid(a.grantee)<>'postgres')),
      'idx', (select json_agg(pg_get_indexdef(indexrelid) order by 1) from pg_index where indrelid=c.oid),
      'src', (select json_agg(distinct d.refobjid::regclass::text) from pg_rewrite r
              join pg_depend d on d.objid=r.oid and d.classid='pg_rewrite'::regclass
               and d.refclassid='pg_class'::regclass and d.refobjid<>c.oid where r.ev_class=c.oid))
      from pg_class c where c.oid=to_regclass('{name}')""") or "null")


def oids(views):
    return {v: meta(v)["oid"] for v in views}


def count(rel):
    return int(admin(f"select count(*) from {rel};"))


def mark():
    return int(admin("select coalesce(max(id),0) from mv_sync.run_log;"))


def logged(action, name=None, since=0):
    cond = f" and view_name='{name}'" if name else ""
    return int(admin(f"select count(*) from mv_sync.run_log where action='{action}' and id>{since}{cond};"))


def built_since(since):
    out = admin(f"select view_name from mv_sync.run_log where action='built' and id>{since};")
    return sorted(out.split())


def log_text(since):
    return admin(f"select string_agg(action||' '||coalesce(view_name,'-')||' '||left(coalesce(detail,''),150), "
                 f"E'\\n') from mv_sync.run_log where id>{since};")


def state(name):
    return json.loads(admin(f"select row_to_json(s) from mv_sync.view_state s where view_name='{name}';") or "{}")


def in_sync(name):
    s = state(name)
    return s.get("built_sig") == s.get("seen_sig") and not s.get("held")


def tick():
    with contextlib.redirect_stdout(io.StringIO()):
        job.tick()


def settle():
    """Notice the changes and wait out the quiet period without building anything."""
    time.sleep(1.5)
    mode = admin("select mode from mv_sync.control;")
    admin("update mv_sync.control set mode='observe';")
    tick()
    admin(f"update mv_sync.control set mode='{mode}';")
    time.sleep(2.5)


def drain(limit=12):
    """Tick until a tick builds nothing (each tick handles one club)."""
    for _ in range(limit):
        before = mark()
        tick()
        if not built_since(before) and not logged("failed", since=before) and not logged("rejected", since=before):
            return


def cycle():
    settle()
    drain()


def touch(note, city=C):
    """Change a road that appears in the street light view."""
    road = f"{city}.{city}_road_net"
    rid = admin(f"select road_id from {view('street_light', city)} where road_id is not null "
                f"order by road_id::text limit 1;")
    admin(f"update {road} set road_name='{note}' where road_id::text='{rid}';")
    return rid


def cli(*args):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        mvsync.main(["--config", CONFIG, *args])
    return out.getvalue()


def compare_with_original(city):
    """New view against the original SQL on the same data; zone/ward may differ only in form."""
    for name in sorted(v for v in ALL_VIEWS if ALL_VIEWS[v]["city"] == city):
        strip = "to_jsonb(x) - 'zone_no' - 'ward_no' - 'geom'"
        raw = ORIGINAL[name].strip().rstrip(";")
        r = json.loads(admin(f"""with o as materialized ({raw})
          select json_build_object('old', (select count(*) from o), 'new', (select count(*) from {name}),
           'other', (select count(*) from (select {strip} j, md5((to_jsonb(x)->'geom')::text) g from o x
                      except all select {strip}, md5((to_jsonb(x)->'geom')::text) from {name} x) a),
           'blanked', (select count(*) from {name} x where to_jsonb(x)->>'ward_no' is null)
                    - (select count(*) from o x where to_jsonb(x)->>'ward_no' is null));"""))
        check(f"data intact: {name} ({r['old']} rows)",
              r["old"] == r["new"] and r["other"] == 0 and r["blanked"] <= 0, r)


# ------------------------------------------------------------------ setup
assert admin("select current_database();") == DB and DB.endswith("_test"), "not a test database"
cfg = json.load(open(os.path.join(HERE, "config.example.json")))
cfg.update(database=DB, user=None, disk_path="/var/lib/postgresql", build_timeout="10min",
           retry_seconds=4, lock_file="/tmp/mv_sync_test.lock", verify_every_seconds=10 ** 9, verify_window=None)
cfg["groups"] = {g: {"quiet": 2, "max_wait": 600, "min_gap": 0, "window": None} for g in ("fast", "medium", "heavy")}
cfg["geoserver"] = {"url": ""}
CONFIG = "/tmp/mv_sync_test_config.json"
json.dump(cfg, open(CONFIG, "w"))
os.environ["PGOPTIONS"] = "-c role=mv_sync_job"
job = mvsync.Job(cfg)
assert job.db.run("select current_user || '@' || current_database();") == f"mv_sync_job@{DB}"

job.views = {k: v for k, v in job.views.items() if v["city"] in (C, OTHER)}
ALL_VIEWS = dict(job.views)
ORIGINAL = {v: admin(f"select pg_get_viewdef('{v}'::regclass);") for v in ALL_VIEWS}
# the same step capture.py performs: remember the definition each view has in this database
current = json.loads(admin("set search_path=pg_catalog; select json_object_agg(n.nspname||'.'||c.relname, "
                           "md5(pg_get_viewdef(c.oid))) from pg_class c join pg_namespace n on n.oid=c.relnamespace "
                           "where relkind='m';"))
print("definitions printed differently after the copy:",
      sum(ALL_VIEWS[v]["live_md5"] != current[v] for v in ALL_VIEWS), "of", len(ALL_VIEWS))
for name in ALL_VIEWS:
    job.views[name]["live_md5"] = current[name]
MINE = sorted(v for v in ALL_VIEWS if ALL_VIEWS[v]["city"] == C)
THEIRS = sorted(v for v in ALL_VIEWS if ALL_VIEWS[v]["city"] == OTHER)
FAST = [v for v in MINE if ALL_VIEWS[v]["group"] == "fast"]
MEDIUM = [v for v in MINE if ALL_VIEWS[v]["group"] == "medium"]
HEAVY = [v for v in MINE if ALL_VIEWS[v]["group"] == "heavy"]

section("A observe mode")
before = oids(ALL_VIEWS)
tick()
check("baseline builds nothing", logged("built") == 0, log_text(0))
check("observe lists never verified views", logged("would_build") == len(ALL_VIEWS), logged("would_build"))
touch("observe-test")
cycle()
check("observe logs the change too", logged("would_build", SL) == 2, log_text(0))
check("observe changes no view", oids(ALL_VIEWS) == before)

section("B clubs: one city and one speed group per run, quickest first")
admin("update mv_sync.control set mode='on';")
rows = {v: count(v) for v in MINE}
grants, indexes = meta(SL)["acl"], meta(SL)["idx"]
touch("club-test")
settle()
for label, expected in (("fast", FAST), ("medium", MEDIUM), ("heavy", HEAVY)):
    m = mark()
    tick()
    check(f"run builds exactly the {label} club ({len(expected)})", built_since(m) == expected, log_text(m))
check("no failures", logged("failed") + logged("rejected") == 0, log_text(0))
check("all views in sync", all(in_sync(v) for v in MINE))
check("row counts unchanged", {v: count(v) for v in MINE} == rows)
check("new data visible", count(f"{SL} where road_name='club-test'") >= 1)
check("grants preserved", sorted(meta(SL)["acl"]) == sorted(grants), (grants, meta(SL)["acl"]))
check("indexes preserved", meta(SL)["idx"] == indexes, meta(SL)["idx"])
check("owner is the job role", meta(SL)["owner"] == "mv_sync_job")
check("build schema empty", count("pg_matviews where schemaname='mv_sync_build'") == 0)
check("other city untouched", oids(THEIRS) == {v: before[v] for v in THEIRS})
m = mark()
cycle()
check("no change means no rebuild", not built_since(m), log_text(m))

section("C data of every view against the original SQL")
compare_with_original(C)

# the slow park view has been proven once; leave it out of the repeated scenarios
job.views = {k: v for k, v in ALL_VIEWS.items() if k != view("park_roads")}
MINE = [v for v in MINE if v != view("park_roads")]

section("D only the views of a changed table are rebuilt")
m = mark()
admin(f"update {C}.hospital set geom=geom where ctid in (select ctid from {C}.hospital limit 1);")
cycle()
check("amenity change builds only its own view", built_since(m) == [HOSP], built_since(m))

section("E tile cache queue")
dup = int(admin("select count(*) - count(distinct layer) from mv_sync.cache_queue;"))
check("queue has no duplicate layers", dup == 0, dup)
queued = int(admin("select count(*) from mv_sync.cache_queue;"))
open("/tmp/mv_sync_test.cred", "w").write("nobody:nothing")
job.cfg["geoserver"] = {"url": "http://127.0.0.1:9/geoserver", "credentials_file": "/tmp/mv_sync_test.cred"}
m = mark()
with contextlib.redirect_stdout(io.StringIO()):
    job.flush_cache()
check("unreachable GeoServer keeps the queue", int(admin("select count(*) from mv_sync.cache_queue;")) == queued > 0)
check("every layer is tried, one failure does not block", logged("alert", since=m) >= queued > 1,
      (logged("alert", since=m), queued))
job.cfg["geoserver"] = {"url": ""}

section("F emptied table, then data returns")
admin(f"create table {C}.zz_road_backup as table {ROAD};")
kept = meta(SL)["oid"]
rows = {v: count(v) for v in MINE}
m = mark()
admin(f"truncate {ROAD};")
cycle()
check("old views kept", meta(SL)["oid"] == kept and {v: count(v) for v in MINE} == rows)
check("empty table rejected", logged("rejected", SL, m) == 1, log_text(m))
m = mark()
cycle()
check("rejected build not repeated", not built_since(m) and logged("rejected", since=m) == 0, log_text(m))
admin(f"insert into {ROAD} select * from {C}.zz_road_backup;")
cycle()
check("recovers by itself when data returns", all(in_sync(v) for v in MINE), [state(v) for v in MINE if not in_sync(v)])

section("G large row drop and accept command")
kept = meta(SL)["oid"]
m = mark()
admin(f"delete from {ROAD} where ctid in (select ctid from {ROAD} where random() < 0.5);")
cycle()
check("50% drop rejected, old kept", meta(SL)["oid"] == kept and logged("rejected", SL, m) == 1, log_text(m))
cli("accept", SL)
cycle()
check("accept lets the smaller view in", meta(SL)["oid"] != kept and count(SL) < rows[SL])
admin(f"truncate {ROAD}; insert into {ROAD} select * from {C}.zz_road_backup; drop table {C}.zz_road_backup;")
admin("update mv_sync.view_state set held=false, fail_count=0, rejected_sig=null;")
cycle()
check("restored", count(SL) == rows[SL], count(SL))

section("H one busy view inside a club")
touch("busy-test")
settle()
holder = background(f"begin; select count(*) from {SL}; select pg_sleep(60); commit;")
kept, others = meta(SL)["oid"], oids([v for v in FAST if v != SL])
m = mark()
tick()
check("busy view waits", meta(SL)["oid"] == kept and logged("retry_later", SL, m) == 1, log_text(m))
check("rest of the club is swapped", logged("swapped", since=m) >= 1 and logged("swapped", SL, m) == 0, log_text(m))
check("busy is not counted as failure", state(SL)["fail_count"] == 0 and logged("failed", since=m) == 0)
check("old data still readable", count(SL) == rows[SL])
stop(holder, "pg_sleep(60)")
time.sleep(4.5)
drain()
check("swaps after the lock is gone", meta(SL)["oid"] != kept and in_sync(SL), state(SL))

section("I one view that cannot be dropped inside a club")
admin(f"create view public.zz_dependent as select road_id from {SL};")
touch("dependent-test")
settle()
kept, m = meta(SL)["oid"], mark()
tick()
check("it is not dropped", meta(SL)["oid"] == kept
      and admin("select to_regclass('public.zz_dependent') is not null;") == "t")
check("only that view is blamed", logged("failed", SL, m) == 1 and logged("failed", since=m) == 1, log_text(m))
check("its neighbours are not marked failed", all(state(v)["fail_count"] == 0 for v in FAST if v != SL))
m = mark()
tick()
check("backs off instead of rebuilding at once", SL not in built_since(m), built_since(m))
admin("drop view public.zz_dependent;")
time.sleep(4.5)
drain()
check("proceeds once the dependency is gone", meta(SL)["oid"] != kept and in_sync(SL), state(SL))

section("J leftover from a killed run")
admin(f"set role mv_sync_job; create materialized view mv_sync_build.mv_{C}_street_light as select 1 x;")
touch("leftover-test")
kept = meta(SL)["oid"]
cycle()
check("leftover cleared and build succeeds",
      count("pg_matviews where schemaname='mv_sync_build'") == 0 and meta(SL)["oid"] != kept)

section("K view dropped by someone")
want = meta(HOSP)
admin(f"drop materialized view {HOSP};")
cycle()
got = meta(HOSP)
check("missing view recreated", got is not None and count(HOSP) == rows[HOSP])
check("recreated view has the grants", got and sorted(got["acl"]) == sorted(want["acl"]), (want, got))

section("L pause, resume and pg_dump")
cli("pause", C)
touch("pause-test")
kept = meta(SL)["oid"]
cycle()
check("paused city is not built", meta(SL)["oid"] == kept)
cli("resume", C)
holder = background("select pg_sleep(30)", app="pg_dump")
tick()
check("waits while pg_dump is connected", meta(SL)["oid"] == kept)
stop(holder, "pg_sleep(30)")
time.sleep(1)
drain()
check("resumes afterwards", meta(SL)["oid"] != kept)
check("status command reports", "mode=on" in cli("status"))

section("M view changed by hand")
definition = admin(f"select pg_get_viewdef('{HOTEL}'::regclass);").rstrip(";")
admin(f"drop materialized view {HOTEL}; create materialized view {HOTEL} as select * from ({definition}) h limit 3;"
      f"grant select on {HOTEL} to public;")
manual = meta(HOTEL)["oid"]
tick()
check("noticed and held", state(HOTEL).get("held") and "outside" in (state(HOTEL).get("held_reason") or ""),
      state(HOTEL))
touch("manual-test")
cycle()
check("manual view is not overwritten", meta(HOTEL)["oid"] == manual and count(HOTEL) == 3)
check("other views keep syncing", in_sync(SL))
cli("release", HOTEL)
tick()
check("release without recapture stays held", state(HOTEL).get("held") and meta(HOTEL)["oid"] == manual, state(HOTEL))

section("N other city: disabled, then enabled")
theirs, mine = oids(THEIRS), oids(MINE)
touch("other-city", OTHER)
m = mark()
cycle()
check("a city that is not activated is never built", oids(THEIRS) == theirs and not built_since(m), built_since(m))
subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-v", f"city={OTHER}", "-f",
                os.path.join(HERE, "sql", "activate_city.sql")], check=True, env=ADMIN_ENV)
m = mark()
cycle()
check("after activation only that city is built",
      built_since(m) and all(v.startswith(OTHER + ".") for v in built_since(m)), built_since(m))
check("first city untouched", oids(MINE) == mine)
check("no failures in the other city", logged("failed", since=m) + logged("rejected", since=m) == 0, log_text(m))
job.views.update({v: ALL_VIEWS[v] for v in THEIRS})
compare_with_original(OTHER)

section("O recovering a view that was recreated by another user")
job.views[HOTEL]["live_md5"] = admin(f"set search_path=pg_catalog; select md5(pg_get_viewdef('{HOTEL}'::regclass));")
cli("release", HOTEL)
m = mark()
cycle()
check("not yet owned by the job: clear message, view kept",
      meta(HOTEL)["oid"] == manual and "activate_city" in admin(
          f"select coalesce(string_agg(detail, ' '), '') from mv_sync.run_log where view_name='{HOTEL}' and id>{m};"),
      log_text(m))
subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-v", f"city={C}", "-f",
                os.path.join(HERE, "sql", "activate_city.sql")], check=True, env=ADMIN_ENV)
cli("release", HOTEL)
cycle()
check("after activating again the job rebuilds it", meta(HOTEL)["oid"] != manual and count(HOTEL) == rows[HOTEL],
      (count(HOTEL), state(HOTEL)))

section("P table renamed, new data under the old name, without _text columns")
rows = {v: count(v) for v in MINE}
rid = touch("pre-rename")
cycle()
old_oid = int(admin(f"select '{ROAD}'::regclass::oid::bigint;"))
theirs = oids(THEIRS)
admin(f"""alter table {ROAD} rename to {C}_road_net_old2;
  create table {ROAD} (like {C}.{C}_road_net_old2 including all);
  insert into {ROAD} select * from {C}.{C}_road_net_old2;
  alter table {ROAD} drop column zone_no_text, drop column ward_no_text;
  update {ROAD} set road_name='renamed-load' where road_id::text='{rid}';""")
m = mark()
cycle()
cycle()
reading_old = [v for v in MINE if f"{C}.{C}_road_net_old2" in meta(v)["src"]]
bad = admin(f"select coalesce(string_agg(view_name||' '||left(detail,200), E'\\n'),'') from mv_sync.run_log "
            f"where action in ('failed','rejected') and id>{m};")
check("new table in place and all views moved to it",
      int(admin(f"select '{ROAD}'::regclass::oid::bigint;")) != old_oid and not reading_old, (reading_old, bad))
check("new load visible", count(f"{SL} where road_name='renamed-load'") >= 1, bad)
check("row counts unchanged", {v: count(v) for v in MINE} == rows, {v: (rows[v], count(v)) for v in MINE})
check("no failures after rename", not bad, bad)
check("other city untouched by the rename", oids(THEIRS) == theirs)

section("Q table missing")
admin(f"alter table {ROAD} rename to {C}_road_net_gone;")
kept, m = meta(SL)["oid"], mark()
cycle()
check("old view kept and alert raised", meta(SL)["oid"] == kept and logged("alert", SL, m) >= 1, log_text(m))
admin(f"alter table {C}.{C}_road_net_gone rename to {C}_road_net;")

section("R rebuild command")
cycle()
m = mark()
cli("rebuild", OTHER)
drain()
check("rebuild builds every view of that city only", built_since(m) == THEIRS, built_since(m))

section("T building while the application keeps writing")
for group in job.cfg["groups"].values():
    group["max_wait"] = 6  # writes never pause, so only the maximum wait can trigger a build
rid = touch("writer-start")
admin("create table public.zz_writes(i integer, ms numeric);")
writer = subprocess.Popen(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-c", f"""do $$
declare t timestamptz; n integer := 0; stop_at timestamptz := clock_timestamp() + interval '75 seconds';
begin
  while clock_timestamp() < stop_at loop
    n := n + 1; t := clock_timestamp();
    update {ROAD} set road_name = 'busy-' || n where road_id::text = '{rid}';
    commit;
    insert into public.zz_writes values (n, extract(epoch from clock_timestamp() - t) * 1000);
    commit;
    perform pg_sleep(0.2);
  end loop;
end $$;"""], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=ADMIN_ENV)
m = mark()
built_while_writing = []
while writer.poll() is None:
    tick()
    if writer.poll() is None:
        built_while_writing = built_since(m)
    time.sleep(1)
errors = writer.communicate()[1]
writes = json.loads(admin("select json_build_object('n', count(*), 'worst', round(max(ms))) from public.zz_writes;"))
check(f"writer ran without errors ({writes['n']} updates)", writer.returncode == 0 and writes["n"] > 100, errors)
check(f"no update was held up (slowest {writes['worst']} ms)", writes["worst"] < 2000, writes)
check("views are rebuilt while writes continue", SL in built_while_writing, built_while_writing)
check("no failures under writes", logged("failed", since=m) + logged("rejected", since=m) == 0, log_text(m))
cycle()
last = admin(f"select road_name from {ROAD} where road_id::text='{rid}';")
check("last write reaches the view", count(f"{SL} where road_name='{last}'") >= 1 and in_sync(SL), last)
admin("drop table public.zz_writes;")

section("U stale before the job ever saw it, and a change the job missed")
for group in job.cfg["groups"].values():
    group["max_wait"] = 600
cycle()
probe = view("street_light", OTHER)
rid = admin(f"select road_id from {probe} where road_id is not null order by road_id::text limit 1;")
road = f"{OTHER}.{OTHER}_road_net"
admin(f"update {road} set road_name='stale-before-job' where road_id::text='{rid}';")
admin(f"delete from mv_sync.view_state where city='{OTHER}';")  # the job meets these views for the first time
for name in THEIRS:  # and, as on a real first install, its captured definitions match the live views
    job.views[name]["live_md5"] = admin(f"set search_path=pg_catalog; select md5(pg_get_viewdef('{name}'::regclass));")
check("view is stale", count(f"{probe} where road_name='stale-before-job'") == 0)
mine = oids(MINE)
cycle()
check("switched-on city is checked and corrected by itself",
      count(f"{probe} where road_name='stale-before-job'") >= 1 and all(in_sync(v) for v in THEIRS))
check("other city not rebuilt for that", oids(MINE) == mine)
admin(f"update {road} set road_name='missed-change' where road_id::text='{rid}';")
time.sleep(1.5)
admin("update mv_sync.control set mode='observe';")
tick()
admin(f"update mv_sync.view_state set built_sig=seen_sig, first_change_at=null where city='{OTHER}';")  # as if missed
admin("update mv_sync.control set mode='on';")
cycle()
check("missed change stays unseen before the daily check", count(f"{probe} where road_name='missed-change'") == 0)
job.cfg["verify_every_seconds"] = 1
before = oids(THEIRS)
m = mark()
for _ in range(12):
    tick()
    if count(f"{probe} where road_name='missed-change'") and logged("built", since=m) >= 8:
        break
check("daily check repairs it", count(f"{probe} where road_name='missed-change'") >= 1, log_text(m))
same = admin(f"select view_name from mv_sync.run_log where id>{m} and action='built' and detail='same';").split()
check("views that already match are not swapped",
      same and all(oids([v])[v] == before[v] for v in same if v in before), same)
job.cfg["verify_every_seconds"] = 10 ** 9

section("S deactivate and uninstall")
rows = {v: count(v) for v in ALL_VIEWS}
for city in (C, OTHER):
    subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-v", f"city={city}", "-f",
                    os.path.join(HERE, "sql", "deactivate_city.sql")], check=True, env=ADMIN_ENV)
check("views handed back", count("pg_matviews where matviewowner='mv_sync_job'") == 0)
p = subprocess.run(["psql", "-X", "-q", "-d", DB, "-f", os.path.join(HERE, "sql", "uninstall.sql")],
                   capture_output=True, text=True, env=ADMIN_ENV)
check("uninstall succeeds", p.returncode == 0, p.stderr)
check("job schemas and role gone", count("pg_namespace where nspname like 'mv_sync%'") == 0
      and count("pg_roles where rolname='mv_sync_job'") == 0)
check("views and rows survive uninstall", {v: count(v) for v in ALL_VIEWS} == rows)

for path in (CONFIG, "/tmp/mv_sync_test.cred", "/tmp/mv_sync_test.lock"):
    with contextlib.suppress(OSError):
        os.remove(path)
print(f"\nRESULT {sum(results)}/{len(results)} passed", flush=True)
