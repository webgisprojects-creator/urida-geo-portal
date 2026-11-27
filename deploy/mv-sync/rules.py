"""Pure rules for the materialized view sync job. No database access here."""
import re
from datetime import datetime, timezone

IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
_NOT_ALIAS = r"(?:WHERE|GROUP|ORDER|LEFT|RIGHT|FULL|INNER|CROSS|JOIN|ON|LIMIT|UNION|WINDOW|HAVING)"


def ident(name):
    if not IDENT.match(name or ""):
        raise ValueError(f"unsafe identifier: {name!r}")
    return name


# ---------------------------------------------------------------- view SQL
def road_aliases(sql, city):
    """Names under which the city's road table is referenced in a view definition."""
    table = f"{city}_road_net"
    found = set()
    pat = rf"\b{city}\.{table}\b(?:[ \t]+(?!{_NOT_ALIAS}\b)([a-z_][a-z0-9_]*))?"
    for m in re.finditer(pat, sql):
        found.add(m.group(1) or table)
    return found


def unrender(sql):
    """Turn the expressions of a view the job already rebuilt back into plain column references.

    PostgreSQL prints them as COALESCE((a.zone_no)::text, (a.zone_no_text)::text) AS zone_no.
    """
    prefix = r"(?P<p>(?:\w+\.)?)"
    zone = rf"COALESCE\(\({prefix}zone_no\)::text, \((?P=p)zone_no_text\)::text\) AS zone_no"
    ward = (rf"COALESCE\(\({prefix}ward_no\)::text, btrim\(replace\(\((?P=p)ward_no_text\)::text, "
            r"' '::text, ''::text\), ','::text\)\) AS ward_no")
    sql = re.sub(zone, r"\g<p>zone_no_text AS zone_no", sql)
    return re.sub(ward, r"\g<p>ward_no_text AS ward_no", sql)


def render(sql, city, kind, has_text_columns):
    """Apply the zone/ward rule to a captured definition.

    With the _text columns: output zone_no/ward_no from the number, falling back to the
    text value. encroachment_summary is left unchanged (it groups by the text value).
    Without them: the definition must not reference them at all.
    """
    sql = unrender(sql)
    aliases = road_aliases(sql, city)
    if len(aliases) == 1:
        # in a single-table query PostgreSQL may omit the table prefix
        only = next(iter(aliases))
        sql = re.sub(r"(?<![\w.])(zone_no_text|ward_no_text) AS (zone_no|ward_no)\b",
                     lambda m: f"{only}.{m.group(1)} AS {m.group(2)}", sql)
    for alias in sorted(aliases):
        for z in ("zone", "ward"):
            num, txt = f"{z}_no", f"{z}_no_text"
            ref = rf"(?<![\w.]){alias}\.{txt}\b"
            if has_text_columns:
                if kind == "encroachment_summary":
                    continue
                fallback = f"{alias}.{txt}::text"
                if z == "ward":
                    fallback = f"btrim(replace({alias}.{txt}::text, ' ', ''), ',')"
                sql = re.sub(rf"{ref} AS {num}\b",
                             lambda _: f"COALESCE({alias}.{num}::text, {fallback}) AS {num}", sql)
            else:
                sql = re.sub(rf"{ref} AS {num}\b", lambda _: f"{alias}.{num}::text AS {num}", sql)
                sql = re.sub(rf"{ref} AS (\w+)", lambda m: f"NULL::text AS {m.group(1)}", sql)
                sql = re.sub(rf"(GROUP BY ){ref}", lambda m: f"{m.group(1)}{alias}.{num}::text", sql)
                sql = re.sub(rf"{ref}(?=\s*(?:,|\n|$))", lambda _: f"NULL::text AS {txt}", sql)
                if re.search(ref, sql):
                    raise ValueError(f"cannot remove {alias}.{txt} from {city} {kind}")
    return sql


# ---------------------------------------------------------------- speed
# Two rewrites that change how PostgreSQL computes a view, not what it returns.
_SLOW_CTES = ("parsed_roads", "nn_roads", "amenity_flags", "scores", "final_scores")
_PROJECTED = re.compile(r"(public\.st_transform\(public\.st_setsrid\(public\.st_force2d\((\w+)\.geom\), 4326\), \d+\)) "
                        r"AS geom\b")
_NEAR_JOIN = re.compile(r"ON \(public\.st_dwithin\(r\.geom, p\.geom, \(10\)::double precision\)")
# about 100 m in degrees, safely wider than the exact 10 m test that follows it
PREFILTER_DEGREES = "0.001"


def optimise(sql, kind, geometry_is_4326):
    """Return a faster definition with the same result, or the definition unchanged.

    road_maintenance: PostgreSQL inlines its CTEs and repeats one to_jsonb call thousands of
    times per road; MATERIALIZED makes each step run once (179 s to 11 s measured).
    *_roads: the 10 m test is made on re-projected geometry, so no spatial index can be used.
    A bounding box test on the stored geometry narrows the pairs first (146 s to 0.9 s measured).
    It is only correct for geometry stored in degrees, hence geometry_is_4326.
    Views written another way are left alone. Applying this twice changes nothing.
    """
    if kind == "road_maintenance":
        names = "|".join(_SLOW_CTES)
        return re.sub(rf"\b({names}) AS \(", r"\1 AS MATERIALIZED (", sql)
    if not (kind.endswith("_roads") and geometry_is_4326) or "raw_geom" in sql:
        return sql
    if len(_PROJECTED.findall(sql)) != 2 or len(_NEAR_JOIN.findall(sql)) != 1:
        return sql
    sql = _PROJECTED.sub(r"\1 AS geom, \2.geom AS raw_geom", sql)
    return _NEAR_JOIN.sub("ON (r.raw_geom OPERATOR(public.&&) public.st_expand(p.raw_geom, "
                          f"({PREFILTER_DEGREES})::double precision) "
                          "AND public.st_dwithin(r.geom, p.geom, (10)::double precision)", sql)


# ---------------------------------------------------------------- clubs
# Views are clubbed by how long they take to build. Times are PostgreSQL query times for
# Ghaziabad on pre-production (2026-11-27); bigger cities will take longer (not measured).
#   fast    street_light, encroachment_summary (< 0.1 s), underdeveloped_analysis (1 s),
#           hospital_roads, education_roads, hotel_roads (2-3.5 s)
#   medium  atm_bank_roads (18 s), road_maintenance (23 s)
#   heavy   park_roads (147 s): built in a night window
# One unit of work is a "club": the due views of ONE city in ONE group. So a slow view never
# delays a quick one of the same city, and a club is swapped together so its maps agree.
# Which views of a city become due is decided per view, from that view's own source tables:
# a change to atm_bank rebuilds only atm_bank_roads, a road table change affects all nine.
GROUP_ORDER = ("fast", "medium", "heavy")
SLOW_KINDS = {"atm_bank_roads": "medium", "road_maintenance": "medium", "park_roads": "heavy"}


def group_of(kind):
    """Unknown kinds count as fast."""
    return SLOW_KINDS.get(kind, "fast")


def choose_club(due, now, overdue_after):
    """Pick the next club to build.

    due: list of (view, city, group, first_change_at). Returns (city, group, [views]) or None.
    Order: anything waiting longer than overdue_after first (nothing starves), then the
    quicker group, then the longest waiting.
    """
    clubs = {}
    for view, city, group, since in due:
        club = clubs.setdefault((city, group), {"views": [], "since": now})
        club["views"].append(view)
        if since is not None:
            club["since"] = min(club["since"], since)
    if not clubs:
        return None

    def rank(key):
        city, group = key
        waited = now - clubs[key]["since"]
        priority = GROUP_ORDER.index(group) if group in GROUP_ORDER else 0
        return (waited <= overdue_after, priority, clubs[key]["since"], city)

    city, group = min(clubs, key=rank)
    return city, group, sorted(clubs[(city, group)]["views"])


# ---------------------------------------------------------------- scheduling
def in_window(window, now):
    """window is None or [start_hour, end_hour] in UTC; it may cross midnight."""
    if not window:
        return True
    start, end = window
    h = datetime.fromtimestamp(now, timezone.utc).hour
    return start <= h < end if start < end else (h >= start or h < end)


def is_dirty(state, sig, repoint):
    return repoint or state.get("built_sig") != sig


def is_due(state, sig, repoint, rule, now):
    """state timestamps are epoch seconds; rule has quiet, max_wait, min_gap, window."""
    if not is_dirty(state, sig, repoint):
        return False
    if state.get("held"):
        return False
    # backing off after a busy lock or a failed attempt
    if now < (state.get("retry_after") or 0):
        return False
    # a rejected build is not repeated until the source changes again
    if state.get("rejected_sig") == sig:
        return False
    if not in_window(rule.get("window"), now):
        return False
    if now - (state.get("last_success_at") or 0) < rule["min_gap"]:
        return False
    last, first = state.get("last_change_at"), state.get("first_change_at")
    quiet = last is not None and now - last >= rule["quiet"]
    waited = first is not None and now - first >= rule["max_wait"]
    # a view that is missing or reads the wrong table may have no change time yet
    return quiet or waited


def observe(state, sig, repoint, now):
    """Update change tracking for one view and return the new state."""
    s = dict(state)
    if s.get("seen_sig") is None:
        # first sight: trust the existing view unless it reads the wrong table
        s["seen_sig"] = sig
        s["built_sig"] = None if repoint else sig
        if repoint:
            s["first_change_at"] = s["last_change_at"] = now
        return s
    if s["seen_sig"] != sig:
        s["seen_sig"] = sig
        s["last_change_at"] = now
        if s.get("first_change_at") is None:
            s["first_change_at"] = now
    elif repoint and s.get("first_change_at") is None:
        s["first_change_at"] = s["last_change_at"] = now
    return s


# ---------------------------------------------------------------- ownership of the definition
def outside_change(expected_oid, live_oid, captured_md5, live_md5):
    """Detect a view that someone else created or changed. Returns a reason or None.

    A missing view is not an outside change: the job may recreate it from the capture.
    """
    if live_oid is None:
        return None
    if expected_oid is None:
        if captured_md5 != live_md5:
            return "live view differs from the captured definition: run capture.py, then release"
        return None
    if expected_oid != live_oid:
        return "view was recreated outside the job: run capture.py, then release"
    return None


# ---------------------------------------------------------------- validation
def _kind_of(column, type_name):
    # PostGIS types are printed with or without "public." depending on search_path
    type_name = type_name.replace("public.", "")
    if column in ("zone_no", "ward_no", "zone_name") and (type_name == "text" or type_name.startswith("character varying")):
        return "string"
    return type_name


def check_columns(old, new):
    """old/new are [[name, type], ...]. Returns a problem description or None."""
    a = [(n, _kind_of(n, t)) for n, t in old]
    b = [(n, _kind_of(n, t)) for n, t in new]
    if a == b:
        return None
    return f"columns differ: only old {sorted(set(a) - set(b))}, only new {sorted(set(b) - set(a))}, or order changed"


def check_rows(old, new, max_drop):
    if old and not new:
        return f"new view is empty (old had {old})"
    if old and new < old * (1 - max_drop):
        return f"rows fell from {old} to {new}"
    return None
