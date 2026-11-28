import hashlib
import io
import os
import tempfile
import unittest
from collections import namedtuple
from datetime import datetime, timedelta
from unittest import mock

import backup
import policy
import receive

GB = 1024 ** 3


def days(n, start=datetime(2026, 11, 1, 18, 30)):
    return [(start + timedelta(days=i)).strftime("%Y%m%dT%H%M%S") for i in range(n)]


class Retention(unittest.TestCase):
    def test_keeps_seven_days_and_four_weeks(self):
        stamps = days(60)
        gone = policy.to_delete(stamps, {s: GB for s in stamps}, 7, 4, 100 * GB)
        kept = sorted(set(stamps) - set(gone))
        self.assertEqual(kept[-7:], stamps[-7:])
        self.assertTrue(7 <= len(kept) <= 11, kept)

    def test_nothing_removed_while_few(self):
        stamps = days(5)
        self.assertEqual(policy.to_delete(stamps, {s: GB for s in stamps}, 7, 4, 100 * GB), [])

    def test_size_cap_removes_oldest_first(self):
        stamps = days(10)
        gone = policy.to_delete(stamps, {s: 3 * GB for s in stamps}, 7, 0, 12 * GB)
        self.assertEqual(sorted(set(stamps) - set(gone)), stamps[-4:])

    def test_newest_two_always_survive(self):
        stamps = days(10)
        gone = policy.to_delete(stamps, {s: 50 * GB for s in stamps}, 7, 4, GB)
        self.assertEqual(sorted(set(stamps) - set(gone)), stamps[-2:])

    def test_room(self):
        self.assertTrue(policy.has_room(60 * GB, GB, 50 * GB))
        self.assertFalse(policy.has_room(50 * GB, GB, 50 * GB))


class Receiver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = {"folder": self.tmp.name, "min_free_gb": 0, "keep_daily": 2, "keep_weekly": 0, "max_total_gb": 10}

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, name, data=b"abc", digest=None, size=None):
        with mock.patch("builtins.print"):
            receive.put(self.cfg, name, digest or hashlib.sha256(data).hexdigest(),
                        len(data) if size is None else size, io.BytesIO(data))

    def finish(self, stamp):
        with mock.patch("builtins.print"):
            receive.finish(self.cfg, stamp)

    def test_stores_and_never_overwrites(self):
        self.put("20261101T183000_db.gpg")
        with self.assertRaises(SystemExit):
            self.put("20261101T183000_db.gpg", b"other")

    def test_bad_checksum_leaves_nothing(self):
        with self.assertRaises(SystemExit):
            self.put("20261101T183000_db.gpg", digest="0" * 64)
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_refuses_names_outside_the_pattern(self):
        for name in ("../x.gpg", "/etc/passwd", "notes.txt", "20261101T183000_../../x.gpg"):
            with self.assertRaises(SystemExit):
                self.put(name)
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_refuses_when_disk_would_get_low(self):
        usage = namedtuple("U", "total used free")(100 * GB, 99 * GB, GB)
        self.cfg["min_free_gb"] = 50
        with mock.patch("shutil.disk_usage", return_value=usage), self.assertRaises(SystemExit):
            self.put("20261101T183000_db.gpg")

    def test_old_sets_removed_and_foreign_files_untouched(self):
        open(os.path.join(self.tmp.name, "someone-else.sql"), "w").close()
        for stamp in days(4):
            self.put(f"{stamp}_db.gpg")
            self.finish(stamp)
        left = sorted(os.listdir(self.tmp.name))
        self.assertIn("someone-else.sql", left)
        self.assertEqual([n for n in left if n.endswith(".gpg")], [f"{s}_db.gpg" for s in days(4)[-2:]])


class Config(unittest.TestCase):
    def test_only_existing_paths_are_packed(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            pass
        try:
            with mock.patch("builtins.print"):
                command = backup.config_command([f.name, "/no/such/path"])
                self.assertIn(os.path.basename(f.name), command)
                self.assertNotIn("/no/such/path", command)
                self.assertIsNone(backup.config_command(["/no/such/path"]))
        finally:
            os.remove(f.name)


if __name__ == "__main__":
    unittest.main()
