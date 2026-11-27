#!/usr/bin/env python3
"""Capture the live materialized views into definitions/ (read-only on the database).

  python capture.py --ssh DB_HOST_ALIAS [--geoserver URL --credentials FILE] [--verify]
  python3 capture.py --local [...]          (on the database server, as postgres)

Writes definitions/manifest.json and, per view, <view>.text.sql (table has the _text
columns) and <view>.plain.sql (table does not). --verify asks PostgreSQL to plan and
describe every statement without running it.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.request

import rules

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "definitions")

CAPTURE = r"""
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT json_agg(v ORDER BY v.view) FROM (
  SELECT n.nspname || '.' || c.relname AS view, n.nspname AS city, c.relname AS name,
         pg_get_viewdef(c.oid) AS def,
         md5(pg_get_viewdef(c.oid)) AS live_md5,
         (SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid)), '[]') FROM pg_index i WHERE i.indrelid = c.oid) AS indexes,
         (SELECT coalesce(json_agg(json_build_array(
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
                   a.privilege_type)), '[]')
            FROM aclexplode(c.relacl) a
           WHERE a.grantee = 0 OR pg_get_userbyid(a.grantee) <> 'postgres') AS grants,
         (SELECT json_agg(DISTINCT tn.nspname || '.' || t.relname)
            FROM pg_rewrite r
            JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass
            JOIN pg_class t ON t.oid = d.refobjid AND t.oid <> c.oid
            JOIN pg_namespace tn ON tn.oid = t.relnamespace
           WHERE r.ev_class = c.oid) AS sources,
         (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
            FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm' AND c.relname LIKE 'mv\_' || n.nspname || '\_%'
) v;
ROLLBACK;
"""


def remote_psql(alias, database, sql):
    """Run SQL on the database server over SSH, or here when alias is None (run as postgres)."""
    psql = f"psql -X -qAt -v ON_ERROR_STOP=1 -d {rules.ident(database)} -f - 2>&1"
    cmd = (["sh", "-c", psql] if alias is None
           else ["ssh", "-o", "BatchMode=yes", alias, f"cd /tmp && sudo -n -u postgres {psql}"])
    p = subprocess.run(cmd, input=sql.encode(), capture_output=True)
    if p.returncode != 0:
        raise SystemExit(p.stdout.decode(errors="replace")[-2000:] + p.stderr.decode(errors="replace")[-500:])
    return p.stdout.decode()


def geoserver_layers(url, credentials):
    with open(credentials, encoding="utf-8") as f:
        auth = "Basic " + base64.b64encode(f.read().strip().encode()).decode()
    req = urllib.request.Request(url.rstrip("/") + "/rest/layers.json", headers={"Authorization": auth})
    with urllib.request.urlopen(req, timeout=60) as r:
        return [l["name"] for l in json.load(r)["layers"]["layer"]]


def verify(alias, database, views):
    """Plan and describe each rendered statement. Nothing is executed or created."""
    script = []
    for v in views:
        for variant in ("text", "plain"):
            with open(os.path.join(OUT, f"{v['view']}.{variant}.sql"), encoding="utf-8") as f:
                sql = f.read().strip().rstrip(";")
            script.append(f"\\echo @@ {v['view']} {variant}\nBEGIN TRANSACTION READ ONLY;\n"
                          f"SELECT * FROM (\n{sql}\n) q \\gdesc\nEXPLAIN (COSTS OFF)\n{sql};\nROLLBACK;")
    out = remote_psql(alias, database, "\n".join(script) + "\n")
    by_view = {v["view"]: v for v in views}
    failures = []
    for block in out.split("@@ ")[1:]:
        head, *lines = block.splitlines()
        view, variant = head.split()
        errors = [l for l in lines if "ERROR" in l]
        if errors:
            failures.append((view, variant, errors[0]))
            continue
        old = by_view[view]["columns"]
        described = [l.split("|", 1) for l in lines[:len(old)]]
        problem = rules.check_columns(old, [[n, t] for n, t in described])
        if problem:
            failures.append((view, variant, problem))
    return failures


def main():
    ap = argparse.ArgumentParser()
    where = ap.add_mutually_exclusive_group(required=True)
    where.add_argument("--ssh", help="SSH alias of the database server")
    where.add_argument("--local", action="store_true", help="this is the database server; run as postgres")
    ap.add_argument("--database", default="nv_allnndb")
    ap.add_argument("--geoserver")
    ap.add_argument("--credentials")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--only", nargs="+", metavar="VIEW",
                    help="refresh just these views (schema.name), e.g. after a manual change; keep the others")
    a = ap.parse_args()

    rows = json.loads(remote_psql(a.ssh, a.database, CAPTURE).strip())
    layers = geoserver_layers(a.geoserver, a.credentials) if a.geoserver else []
    os.makedirs(OUT, exist_ok=True)
    manifest, warnings, changed = [], [], 0
    if a.only:
        with open(os.path.join(OUT, "manifest.json"), encoding="utf-8") as f:
            previous = {v["view"]: v for v in json.load(f)["views"]}
        unknown = set(a.only) - {r["view"] for r in rows}
        if unknown:
            raise SystemExit(f"no such view: {sorted(unknown)}")
        manifest = [v for k, v in previous.items() if k not in a.only]
        rows = [r for r in rows if r["view"] in a.only]
        if not layers:
            layers = [l for k in a.only if k in previous for l in previous[k]["layers"]]
    for r in rows:
        city, kind = r["city"], r["name"][len(f"mv_{r['city']}_"):]
        odd = [s for s in r["sources"] if re.search(r"_(old|new|archive|reshape|backup|bkp)\d*$", s)]
        if odd:
            warnings.append(f"{r['view']} reads {odd}: capture is not safe for this view")
        raw = r["def"].strip()
        for variant, has_text in (("text", True), ("plain", False)):
            try:
                sql = rules.render(raw, city, kind, has_text)
            except ValueError as e:
                warnings.append(str(e))
                sql = raw
            changed += has_text and sql != raw
            with open(os.path.join(OUT, f"{r['view']}.{variant}.sql"), "w", encoding="utf-8", newline="\n") as f:
                f.write(sql + "\n")
        manifest.append({"view": r["view"], "city": city, "name": r["name"], "group": rules.group_of(kind),
                         "sources": sorted(r["sources"]), "indexes": r["indexes"], "grants": r["grants"],
                         "columns": r["columns"], "live_md5": r["live_md5"],
                         "layers": [l for l in layers if l.split(":")[-1].lower() == r["name"]]})
    manifest.sort(key=lambda v: v["view"])
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"views": manifest}, f, indent=1)
    print(f"captured {len(manifest)} views; zone/ward rule changes {changed}; "
          f"with a GeoServer layer {sum(bool(v['layers']) for v in manifest)}")
    for w in warnings:
        print("WARNING", w)
    if a.verify:
        checked = [v for v in manifest if not a.only or v["view"] in a.only]
        failures = verify(a.ssh, a.database, checked)
        print(f"verified {len(checked) * 2} statements, failures: {len(failures)}")
        for f_ in failures[:40]:
            print("FAIL", *f_)
        return 1 if failures else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
