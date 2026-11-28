#!/usr/bin/env python3
"""Runs daily on the database server (as root): dump, encrypt, verify, send, tidy up.

No unencrypted dump is ever written to disk. Exit status is non-zero if anything failed, so
the systemd unit shows as failed. Standard library only.
"""
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import policy

HERE = os.path.dirname(os.path.abspath(__file__))


def log(message):
    print(message, flush=True)


def sh(command):
    """Run a shell pipeline that fails if any part fails."""
    p = subprocess.run(["bash", "-o", "pipefail", "-c", command], capture_output=True, text=True, check=False)
    if p.returncode:
        raise RuntimeError(f"command failed: {command}\n{p.stderr[-800:]}")
    return p.stdout


def checksum(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def databases():
    out = sh("cd /tmp && sudo -n -u postgres psql -X -qAt -d template1 -c "
             "'select datname from pg_database where datallowconn and not datistemplate order by 1'")
    names = out.split()
    if not names:
        raise RuntimeError("no databases found")
    return names


def config_command(paths):
    """A tar of the server's configuration, or None. Paths that do not exist are reported and skipped."""
    present = [p for p in paths if os.path.exists(p)]
    for p in sorted(set(paths) - set(present)):
        log(f"config path not present, skipped: {p}")
    if not present:
        return None
    return "tar -czf - -- " + " ".join(shlex.quote(p) for p in present)


def local_sets(folder):
    found = {}
    for name in os.listdir(folder):
        stamp = policy.stamp_of(name)
        if stamp:
            found.setdefault(stamp, []).append(name)
    return found


def main():
    with open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "backup.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    folder, key = cfg["folder"], cfg["passphrase_file"]
    os.makedirs(folder, mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")

    previous = local_sets(folder)
    last = max(previous, default=None)
    expected = sum(os.path.getsize(os.path.join(folder, n)) for n in previous.get(last, []))
    free = shutil.disk_usage(folder).free
    if not policy.has_room(free, expected * 2, cfg["min_free_gb"] * 1024 ** 3):
        raise RuntimeError(f"not enough disk here: {free // 1024 ** 3} GB free")

    gpg = f"gpg --batch --quiet --pinentry-mode loopback --passphrase-file {shlex.quote(key)}"
    files = []
    dump = "sudo -n -u postgres "
    # (name, command that writes the content, command that proves the content is readable)
    jobs = [("globals", dump + "pg_dumpall -l template1 --globals-only", "cat > /dev/null")]
    jobs += [(db, dump + f"pg_dump -Fc -d {shlex.quote(db)}", "pg_restore -f /dev/null") for db in databases()]
    configs = config_command(cfg.get("config_paths", []))
    if configs:
        jobs.append(("serverconfig", configs, "tar -tzf - > /dev/null"))
    try:
        for name, command, reader in jobs:
            filename = f"{stamp}_{name}.gpg"
            if not policy.stamp_of(filename):
                raise RuntimeError(f"database name not usable in a file name: {name}")
            path = os.path.join(folder, filename)
            files.append(path)
            sh(f"cd /tmp && umask 077 && nice -n 15 {command} | "
               f"{gpg} --symmetric --cipher-algo AES256 -o {shlex.quote(path)}")
            # prove the file decrypts and its content can be read from start to end
            sh(f"cd /tmp && {gpg} -d {shlex.quote(path)} | {reader}")
            log(f"made and verified {filename} ({os.path.getsize(path) // 1024 ** 2} MB)")
    except Exception:
        for path in files:  # only files this run created
            if os.path.exists(path):
                os.remove(path)
        raise

    ssh = cfg["ssh_command"]  # e.g. ssh -i KEY -o BatchMode=yes user@host
    for path in files:
        name = os.path.basename(path)
        request = f"put {name} {checksum(path)} {os.path.getsize(path)}"
        for attempt in (1, 2, 3):
            try:
                sh(f"{ssh} {shlex.quote(request)} < {shlex.quote(path)}")
                break
            except RuntimeError as e:
                if "already exists" in str(e):
                    break
                if attempt == 3 or "refused" in str(e):
                    raise
        log(f"sent {name}")
    log(sh(f"{ssh} {shlex.quote('finish ' + stamp)}").strip())

    # local copies are tidied only after the remote copy is complete
    found = local_sets(folder)
    sizes = {s: sum(os.path.getsize(os.path.join(folder, n)) for n in found[s]) for s in found}
    for old in policy.to_delete(found, sizes, cfg["keep_daily"], cfg["keep_weekly"], cfg["max_total_gb"] * 1024 ** 3):
        for name in found[old]:
            os.remove(os.path.join(folder, name))
        log(f"removed local set {old}")
    log("backup finished")


if __name__ == "__main__":
    main()
