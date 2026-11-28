import unittest

import mvsync
import rules

SQL = """ SELECT ghaziabad_road_net.zone_no_text AS zone_no,
            ghaziabad_road_net.ward_no_text AS ward_no
           FROM ghaziabad.ghaziabad_road_net
          GROUP BY ghaziabad_road_net.zone_no_text"""
CTE = """ WITH p AS ( SELECT r.zone_no_text,
            r.ward_no_text,
            r.zone_no
           FROM ghaziabad.ghaziabad_road_net r)
 SELECT n.zone_no_text, n.zone_no FROM p n"""
RULE = {"quiet": 180, "max_wait": 900, "min_gap": 600, "window": None}


class Render(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(rules.road_aliases(SQL, "ghaziabad"), {"ghaziabad_road_net"})
        self.assertEqual(rules.road_aliases(CTE, "ghaziabad"), {"r"})

    def test_number_first(self):
        out = rules.render(SQL, "ghaziabad", "street_light", True)
        self.assertIn("COALESCE(ghaziabad_road_net.zone_no::text, ghaziabad_road_net.zone_no_text::text) AS zone_no", out)
        self.assertIn("btrim(replace(ghaziabad_road_net.ward_no_text::text, ' ', ''), ',')) AS ward_no", out)

    def test_encroachment_unchanged_with_text(self):
        self.assertEqual(rules.render(SQL, "ghaziabad", "encroachment_summary", True), SQL)

    def test_without_text_columns(self):
        out = rules.render(SQL, "ghaziabad", "encroachment_summary", False)
        self.assertNotIn("_no_text", out)
        self.assertIn("GROUP BY ghaziabad_road_net.zone_no::text", out)

    def test_without_text_columns_through_cte(self):
        out = rules.render(CTE, "ghaziabad", "road_maintenance", False)
        self.assertIn("NULL::text AS zone_no_text,", out)
        self.assertNotIn("r.zone_no_text,", out)
        self.assertIn("n.zone_no_text", out)  # CTE reference stays, the CTE still has the column

    def test_rebuilt_view_can_be_captured_again(self):
        rebuilt = """ SELECT COALESCE((r.zone_no)::text, (r.zone_no_text)::text) AS zone_no,
    COALESCE((r.ward_no)::text, btrim(replace((r.ward_no_text)::text, ' '::text, ''::text), ','::text)) AS ward_no
   FROM ghaziabad.ghaziabad_road_net r"""
        self.assertIn("r.zone_no::text, r.zone_no_text::text", rules.render(rebuilt, "ghaziabad", "x", True))
        self.assertNotIn("_no_text", rules.render(rebuilt, "ghaziabad", "x", False))
        unqualified = rebuilt.replace("r.", "").replace("_road_net r", "_road_net")
        self.assertNotIn("_no_text", rules.render(unqualified, "ghaziabad", "x", False))

    def test_unremovable_reference_is_an_error(self):
        sql = "SELECT upper(r.zone_no_text) FROM ghaziabad.ghaziabad_road_net r"
        with self.assertRaises(ValueError):
            rules.render(sql, "ghaziabad", "x", False)


class Schedule(unittest.TestCase):
    def test_first_sight_trusts_correct_view(self):
        s = rules.observe({}, "a", False, 1000)
        self.assertFalse(rules.is_dirty(s, "a", False))

    def test_first_sight_of_renamed_table_is_dirty(self):
        s = rules.observe({}, "a", True, 1000)
        self.assertTrue(rules.is_due(s, "a", True, RULE, 1200))

    def test_waits_for_quiet(self):
        s = rules.observe(rules.observe({}, "a", False, 0), "b", False, 1000)
        self.assertFalse(rules.is_due(s, "b", False, RULE, 1100))
        self.assertTrue(rules.is_due(s, "b", False, RULE, 1181))

    def test_continuous_updates_still_build(self):
        s = rules.observe({}, "0", False, 0)
        t = 1000
        for i in range(1, 17):
            s = rules.observe(s, str(i), False, t)
            t += 60
        self.assertTrue(rules.is_due(s, "16", False, RULE, t))

    def test_held_rejected_and_gap(self):
        s = {"built_sig": "a", "seen_sig": "b", "first_change_at": 0, "last_change_at": 0}
        self.assertTrue(rules.is_due(s, "b", False, RULE, 5000))
        self.assertFalse(rules.is_due(dict(s, held=True), "b", False, RULE, 5000))
        self.assertFalse(rules.is_due(dict(s, rejected_sig="b"), "b", False, RULE, 5000))
        self.assertTrue(rules.is_due(dict(s, rejected_sig="old"), "b", False, RULE, 5000))
        self.assertFalse(rules.is_due(dict(s, last_success_at=4900), "b", False, RULE, 5000))

    def test_night_window(self):
        self.assertTrue(rules.in_window([20, 23], 21 * 3600))
        self.assertFalse(rules.in_window([20, 23], 12 * 3600))
        self.assertTrue(rules.in_window([22, 2], 3600))


class Verification(unittest.TestCase):
    seen = {"built_sig": "a", "seen_sig": "a"}

    def need(self, state, now=21 * 3600, window=(20, 23), rule=RULE, sig="a"):
        return rules.needs_verification(state, sig, False, rule, now, 72000, window)

    def test_never_verified_is_checked_at_any_hour(self):
        self.assertTrue(self.need(self.seen, now=12 * 3600))

    def test_then_only_when_old_and_in_the_window(self):
        night = 10 * 86400 + 21 * 3600
        self.assertFalse(self.need(dict(self.seen, last_success_at=night - 3600), now=night))
        self.assertTrue(self.need(dict(self.seen, last_success_at=night - 86400), now=night))
        self.assertFalse(self.need(dict(self.seen, last_success_at=night - 86400), now=night - 9 * 3600))

    def test_not_for_changed_held_rejected_or_backing_off(self):
        self.assertFalse(self.need(self.seen, sig="b"))
        self.assertFalse(self.need(dict(self.seen, held=True)))
        self.assertFalse(self.need(dict(self.seen, rejected_sig="a")))
        self.assertFalse(self.need(dict(self.seen, retry_after=10 ** 12)))

    def test_group_window_still_applies(self):
        self.assertFalse(self.need(self.seen, now=12 * 3600, rule=dict(RULE, window=[20, 23])))

    def test_real_changes_go_first(self):
        due = [("a.light", "a", "fast", None, True), ("b.atm", "b", "medium", 90, False)]
        self.assertEqual(rules.choose_club(due, 100, 3600)[0], "b")


class OutsideChange(unittest.TestCase):
    def test_cases(self):
        self.assertIsNone(rules.outside_change(None, 10, "a", "a"))
        self.assertIsNotNone(rules.outside_change(None, 10, "a", "b"))
        self.assertIsNone(rules.outside_change(10, 10, "a", "b"))   # table rename keeps the object
        self.assertIsNotNone(rules.outside_change(10, 11, "a", "a"))
        self.assertIsNone(rules.outside_change(10, None, "a", None))


NEAR = """ SELECT DISTINCT r.gid, public.st_transform(r.geom, 4326) AS geom
   FROM (( SELECT public.st_transform(public.st_setsrid(public.st_force2d(agra_road_net.geom), 4326), 32644) AS geom
           FROM agra.agra_road_net) r
     JOIN ( SELECT public.st_transform(public.st_setsrid(public.st_force2d(park.geom), 4326), 32644) AS geom
           FROM agra.park) p ON (public.st_dwithin(r.geom, p.geom, (10)::double precision)))"""


class Speed(unittest.TestCase):
    def test_near_view_gets_a_prefilter_once(self):
        out = rules.optimise(NEAR, "park_roads", True)
        self.assertIn("agra_road_net.geom AS raw_geom", out)
        self.assertIn("park.geom AS raw_geom", out)
        self.assertIn("OPERATOR(public.&&)", out)
        self.assertIn("public.st_dwithin(r.geom, p.geom, (10)::double precision)", out)  # exact test stays
        self.assertEqual(rules.optimise(out, "park_roads", True), out)
        self.assertEqual(out.count("("), out.count(")"))

    def test_no_prefilter_unless_stored_in_degrees(self):
        self.assertEqual(rules.optimise(NEAR, "park_roads", False), NEAR)

    def test_unknown_shape_is_left_alone(self):
        other = NEAR.replace("(10)::double precision", "(25)::double precision")
        self.assertEqual(rules.optimise(other, "park_roads", True), other)

    def test_maintenance_steps_are_materialised_once(self):
        sql = "WITH road_counts AS MATERIALIZED ( x ), parsed_roads AS ( y ), scores AS ( z ) SELECT 1"
        out = rules.optimise(sql, "road_maintenance", False)
        self.assertIn("parsed_roads AS MATERIALIZED (", out)
        self.assertIn("scores AS MATERIALIZED (", out)
        self.assertEqual(rules.optimise(out, "road_maintenance", False), out)

    def test_other_views_unchanged(self):
        self.assertEqual(rules.optimise(NEAR, "street_light", True), NEAR)


class Clubs(unittest.TestCase):
    def test_groups(self):
        self.assertEqual(rules.group_of("street_light"), "fast")
        self.assertEqual(rules.group_of("road_maintenance"), "medium")
        self.assertEqual(rules.group_of("park_roads"), "heavy")

    def test_one_city_one_group_quickest_first(self):
        due = [("a.park", "a", "heavy", 0), ("a.light", "a", "fast", 50), ("a.hotel", "a", "fast", 60),
               ("b.atm", "b", "medium", 10)]
        self.assertEqual(rules.choose_club(due, 100, 3600), ("a", "fast", ["a.hotel", "a.light"]))

    def test_longest_waiting_city_first_within_a_group(self):
        due = [("a.light", "a", "fast", 50), ("b.light", "b", "fast", 10)]
        self.assertEqual(rules.choose_club(due, 100, 3600)[0], "b")

    def test_overdue_club_is_not_starved(self):
        due = [("a.light", "a", "fast", 9990), ("b.park", "b", "heavy", 0)]
        self.assertEqual(rules.choose_club(due, 10000, 3600)[:2], ("b", "heavy"))

    def test_nothing_due(self):
        self.assertIsNone(rules.choose_club([], 100, 3600))

    def test_backoff(self):
        s = {"built_sig": "a", "first_change_at": 0, "last_change_at": 0, "retry_after": 6000}
        self.assertFalse(rules.is_due(s, "b", False, RULE, 5000))
        self.assertTrue(rules.is_due(s, "b", False, RULE, 6001))


class FakeJob(mvsync.Job):
    """Real swap logic, no database."""

    def __init__(self, errors):
        self.cfg = {"retry_seconds": 300, "max_failures": 3}
        self.errors, self.swapped_sets, self.saved, self.actions = errors, [], {}, []

    def run_swap(self, views, found):
        for v in views:
            if v in self.errors:
                raise mvsync.SqlError(self.errors[v])
        self.swapped_sets.append(list(views))

    def save(self, view, state):
        self.saved[view] = dict(state)

    def log(self, view, action, detail="", ms=None):
        self.actions.append((action, view))


class Swap(unittest.TestCase):
    def found(self, *views):
        return {v: {"sig": "s", "state": {}} for v in views}

    def test_whole_club_in_one_transaction(self):
        job = FakeJob({})
        self.assertEqual(job.swap_club(["a", "b"], self.found("a", "b")), ["a", "b"])
        self.assertEqual(job.swapped_sets, [["a", "b"]])

    def test_busy_view_does_not_block_or_count_as_failure(self):
        job = FakeJob({"a": "canceling statement due to lock timeout"})
        self.assertEqual(job.swap_club(["a", "b"], self.found("a", "b")), ["b"])
        self.assertNotIn("fail_count", job.saved["a"])
        self.assertIn("retry_after", job.saved["a"])
        self.assertNotIn("b", job.saved)

    def test_broken_view_alone_is_blamed(self):
        job = FakeJob({"b": "cannot drop because other objects depend on it"})
        self.assertEqual(job.swap_club(["a", "b", "c"], self.found("a", "b", "c")), ["a", "c"])
        self.assertEqual(list(job.saved), ["b"])
        self.assertEqual(job.saved["b"]["fail_count"], 1)

    def test_single_view_club(self):
        job = FakeJob({"a": "lock timeout"})
        self.assertEqual(job.swap_club(["a"], self.found("a")), [])
        self.assertIn(("retry_later", "a"), job.actions)


class Isolation(unittest.TestCase):
    """A change in one city's table must never mark another city's views."""

    def setUp(self):
        self.job = FakeJob({})
        self.job.views = {}
        for city in ("agra", "ghaziabad"):
            road = f"{city}.{city}_road_net"
            for kind, extra in (("street_light", []), ("atm_bank_roads", [f"{city}.atm_bank"])):
                self.job.views[f"{city}.mv_{city}_{kind}"] = {"city": city, "sources": [road] + extra}
        self.job.definition = lambda view, variant: view
        self.facts = {s: {"oid": 1, "ins": 0, "zt": True, "wt": True}
                      for v in self.job.views.values() for s in v["sources"]}

    def changed_by(self, table):
        before = {v: self.job.signature(v, self.facts)[0] for v in self.job.views}
        self.facts[table] = dict(self.facts[table], ins=1)
        return sorted(v for v in self.job.views if self.job.signature(v, self.facts)[0] != before[v])

    def test_road_change_stays_in_its_city(self):
        self.assertEqual(self.changed_by("ghaziabad.ghaziabad_road_net"),
                         ["ghaziabad.mv_ghaziabad_atm_bank_roads", "ghaziabad.mv_ghaziabad_street_light"])

    def test_amenity_change_marks_only_its_view(self):
        self.assertEqual(self.changed_by("ghaziabad.atm_bank"), ["ghaziabad.mv_ghaziabad_atm_bank_roads"])


class Validation(unittest.TestCase):
    def test_columns(self):
        old = [["zone_no", "character varying(1)"], ["geom", "public.geometry"]]
        self.assertIsNone(rules.check_columns(old, [["zone_no", "text"], ["geom", "public.geometry"]]))
        self.assertIsNotNone(rules.check_columns(old, [["zone_no", "integer"], ["geom", "public.geometry"]]))
        self.assertIsNotNone(rules.check_columns(old, [["zone_no", "text"]]))

    def test_rows(self):
        self.assertIsNone(rules.check_rows(100, 90, 0.2))
        self.assertIsNotNone(rules.check_rows(100, 0, 0.2))
        self.assertIsNotNone(rules.check_rows(100, 50, 0.2))
        self.assertIsNone(rules.check_rows(0, 0, 0.2))


if __name__ == "__main__":
    unittest.main()
