#!/usr/bin/env python3
"""Compare, read-only, what the job would build with what each live view holds now.

  python compare.py --ssh DB_HOST_ALIAS [--city CITY ...]      (from this machine)
  python3 compare.py --local [--city CITY ...]                 (on the database server, as postgres)

Run it before activating a city. For every view it runs the job's SQL (zone/ward rule and speed
rewrites) in a read-only transaction and compares rows with the live view, ignoring zone_no and
ward_no. Where they differ it runs the view's own original SQL on today's data as well: STALE means
that gives the same result as the job (the live view is just out of date), DIFF means the job's SQL
really returns something else. The original SQL can be slow. Exit status 1 for any DIFF or ERROR.
"""
import argparse
import json
import os
import subprocess
import sys

import rules

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "definitions")


def statement(view, kind, degrees, other=None):
    """Compare the job's SQL with the live view, or with another SQL statement given as `other`."""
    against = f"({other.strip().rstrip(';')})" if other else view
    with open(os.path.join(OUT, f"{view}.text.sql"), encoding="utf-8") as f:
        sql = rules.optimise(f.read().strip().rstrip(";"), kind, degrees)
    strip = "to_jsonb(x) - 'zone_no' - 'ward_no'"
    return f"""BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15min';
SELECT clock_timestamp() AS t0 \\gset
WITH c AS MATERIALIZED ({sql}),
 a AS MATERIALIZED (SELECT md5(({strip})::text) h FROM c x),
 t AS MATERIALIZED (SELECT count(*) n, extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) s FROM a),
 b AS MATERIALIZED (SELECT md5(({strip})::text) h FROM {against} x)
SELECT 'VIEW|{view}', t.n, (SELECT count(*) FROM b),
 (SELECT count(*) FROM (SELECT h FROM a EXCEPT ALL SELECT h FROM b) y),
 (SELECT count(*) FROM (SELECT h FROM b EXCEPT ALL SELECT h FROM a) z), round(t.s::numeric, 1) FROM t;
ROLLBACK;
"""


def main():
    ap = argparse.ArgumentParser()
    where = ap.add_mutually_exclusive_group(required=True)
    where.add_argument("--ssh")
    where.add_argument("--local", action="store_true")
    ap.add_argument("--database", default="nv_allnndb")
    ap.add_argument("--city", nargs="+")
    ap.add_argument("--view", nargs="+", metavar="VIEW", help="only these views (schema.name)")
    a = ap.parse_args()
    with open(os.path.join(OUT, "manifest.json"), encoding="utf-8") as f:
        views = [v for v in json.load(f)["views"] if not a.city or v["city"] in a.city]

    psql = f"psql -X -qAt -F '|' -v ON_ERROR_STOP=1 -d {rules.ident(a.database)} -f - 2>&1"
    cmd = ["sh", "-c", psql] if a.local else ["ssh", "-o", "BatchMode=yes", a.ssh, f"cd /tmp && sudo -n -u postgres {psql}"]

    def run(sql):
        p = subprocess.run(cmd, input=sql.encode(), capture_output=True, check=False)
        return p.returncode, p.stdout.decode(errors="replace").strip()

    code, out = run("SELECT f_table_schema || '.' || f_table_name FROM public.geometry_columns "
                    "WHERE srid = 4326 AND f_geometry_column = 'geom';\n")
    if code:
        raise SystemExit(out)
    in_degrees = set(out.split())
    bad = 0
    if a.view:
        views = [v for v in views if v["view"] in a.view]
    for v in views:
        kind = v["name"][len(f"mv_{v['city']}_"):]
        degrees = all(s in in_degrees for s in v["sources"])
        code, out = run(statement(v["view"], kind, degrees))
        row = next((line for line in out.splitlines() if line.startswith("VIEW|")), None)
        if code or not row:
            bad += 1
            print(f"ERROR {v['view']}: {out[-300:]}", flush=True)
            continue
        _, view, new, live, only_new, only_live, seconds = row.split("|")
        same = new == live and only_new == "0" and only_live == "0"
        verdict, note = "SAME ", ""
        if not same:
            code, original = run(f"SET search_path = pg_catalog;\nSELECT pg_get_viewdef('{view}'::regclass);\n")
            original = original.removeprefix("SET").strip()
            code, out = run(statement(view, kind, degrees, original)) if not code else (code, original)
            again = next((line for line in out.splitlines() if line.startswith("VIEW|")), None)
            if code or not again:
                verdict, note = "ERROR", f" original SQL failed: {out[-200:]}"
            else:
                _, _, n2, o2, extra, missing, took = again.split("|")
                ok = n2 == o2 and extra == "0" and missing == "0"
                verdict = "STALE" if ok else "DIFF "
                note = f" | against original SQL now: rows {n2}/{o2} only-new {extra} only-original {missing}"
            bad += verdict != "STALE"
        print(f"{verdict} {view} rows {new}/{live} only-new {only_new} only-live {only_live} {seconds}s{note}",
              flush=True)
    print(f"RESULT {len(views) - bad}/{len(views)} correct")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
