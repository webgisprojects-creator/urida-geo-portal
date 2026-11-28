"""Which backups to keep and when to refuse a new one. Pure rules, used by both servers."""
import re
from datetime import datetime

# one backup run = one set of files sharing a time stamp: 20261127T183000_<name>.gpg
NAME = re.compile(r"^(?P<stamp>\d{8}T\d{6})_[A-Za-z0-9_.-]+\.gpg$")


def stamp_of(filename):
    m = NAME.match(filename)
    return m.group("stamp") if m else None


def to_delete(stamps, sizes, keep_daily, keep_weekly, max_total, never_below=2):
    """Return the backup sets to remove.

    stamps: complete backup sets. sizes: stamp -> bytes.
    Kept: the newest `keep_daily` sets, plus the newest set of each of the last `keep_weekly`
    weeks. If those still exceed `max_total` bytes, the oldest go first. The newest
    `never_below` sets are never removed, whatever the limits say.
    """
    ordered = sorted(set(stamps), reverse=True)
    keep = set(ordered[:max(keep_daily, never_below)])
    weeks = {}
    for s in ordered:
        year, week, _ = datetime.strptime(s, "%Y%m%dT%H%M%S").isocalendar()
        weeks.setdefault((year, week), s)  # ordered newest first
    keep.update(list(weeks.values())[:keep_weekly])
    protected = set(ordered[:never_below])
    total = sum(sizes.get(s, 0) for s in keep)
    for s in sorted(keep):
        if total <= max_total:
            break
        if s not in protected:
            keep.remove(s)
            total -= sizes.get(s, 0)
    return sorted(set(ordered) - keep)


def has_room(free_bytes, incoming_bytes, min_free_bytes):
    """A new backup is accepted only if the disk keeps at least min_free_bytes afterwards."""
    return free_bytes - incoming_bytes >= min_free_bytes
