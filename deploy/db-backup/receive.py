#!/usr/bin/env python3
"""Runs on the backup server as the only command the database server's key may execute.

authorized_keys line:  restrict,command="/opt/db-backup/receive.py" ssh-ed25519 AAAA...
Requests (SSH_ORIGINAL_COMMAND):
  put <file> <sha256> <bytes>   store a file read from standard input
  finish <stamp>                mark a set complete, then remove old sets
  status                        list complete sets
The sender cannot read, overwrite or delete anything: removal follows the policy here only.
Files are touched only inside the backup folder, and only names matching the backup pattern.
"""
import hashlib
import json
import os
import shutil
import sys

import policy

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    with open(os.path.join(HERE, "receive.json"), encoding="utf-8") as f:
        return json.load(f)


def sets(folder):
    """stamp -> list of files, split into complete and incomplete."""
    found = {}
    for name in os.listdir(folder):
        stamp = policy.stamp_of(name)
        if stamp:
            found.setdefault(stamp, []).append(name)
    done = {s for s in found if os.path.exists(os.path.join(folder, f"{s}.complete"))}
    return found, done


def remove_set(folder, stamp, files):
    for name in files:
        os.remove(os.path.join(folder, name))
    marker = os.path.join(folder, f"{stamp}.complete")
    if os.path.exists(marker):
        os.remove(marker)


def put(cfg, name, digest, size, stream):
    folder = cfg["folder"]
    if not policy.stamp_of(name):
        raise SystemExit("refused: unexpected file name")
    target = os.path.join(folder, name)
    if os.path.exists(target):
        raise SystemExit("refused: file already exists")
    size = int(size)
    free = shutil.disk_usage(folder).free
    if not policy.has_room(free, size, cfg["min_free_gb"] * 1024 ** 3):
        raise SystemExit(f"refused: only {free // 1024 ** 3} GB free, {cfg['min_free_gb']} GB must stay free")
    partial = target + ".partial"
    seen, written = hashlib.sha256(), 0
    try:
        with open(partial, "wb") as out:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > size:
                    raise SystemExit("refused: more data than announced")
                seen.update(chunk)
                out.write(chunk)
        if written != size or seen.hexdigest() != digest:
            raise SystemExit("refused: size or checksum does not match")
        os.chmod(partial, 0o600)
        os.rename(partial, target)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    print("stored", name)


def finish(cfg, stamp):
    folder = cfg["folder"]
    found, done = sets(folder)
    if stamp not in found:
        raise SystemExit("refused: no files for this stamp")
    open(os.path.join(folder, f"{stamp}.complete"), "w").close()
    done.add(stamp)
    sizes = {s: sum(os.path.getsize(os.path.join(folder, n)) for n in found[s]) for s in done}
    old = policy.to_delete(done, sizes, cfg["keep_daily"], cfg["keep_weekly"], cfg["max_total_gb"] * 1024 ** 3)
    # unfinished sets older than the newest complete one are leftovers of failed runs
    leftovers = [s for s in found if s not in done and s < max(done)]
    for s in old + leftovers:
        remove_set(folder, s, found[s])
        print("removed", s)
    print("complete", stamp)


def main(argv, stream):
    cfg = load_config()
    if argv[:1] == ["put"] and len(argv) == 4:
        put(cfg, argv[1], argv[2], argv[3], stream)
    elif argv[:1] == ["finish"] and len(argv) == 2:
        finish(cfg, argv[1])
    elif argv == ["status"]:
        print("\n".join(sorted(sets(cfg["folder"])[1])))
    else:
        raise SystemExit("refused: unknown request")


if __name__ == "__main__":
    main(os.environ.get("SSH_ORIGINAL_COMMAND", " ".join(sys.argv[1:])).split(), sys.stdin.buffer)
