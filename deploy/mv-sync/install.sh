#!/usr/bin/env bash
# Install the materialized view sync job on a PostgreSQL server. Run as root, on the database server itself.
#
#   sudo bash install.sh --database NAME            check only, changes nothing
#   sudo bash install.sh --database NAME --apply    install, left in "observe" mode (no view is touched)
#
# Safe to read before running: every change is listed under "apply" below. Undo with uninstall.sh.
set -euo pipefail

DB="" APPLY=0
while [ $# -gt 0 ]; do
  case $1 in
    --database) DB=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
[[ $DB =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "usage: install.sh --database NAME [--apply]"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

SRC=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=/opt/mv-sync
ETC=/etc/mv-sync
OSUSER=mv_sync_job
cd /tmp
sql() { sudo -n -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

# ------------------------------------------------------------------ checks
fail=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fail=1; }
for tool in psql python3 systemctl flock useradd; do
  command -v "$tool" >/dev/null && ok "$tool present" || bad "$tool missing"
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' && ok "python 3.9 or newer" || bad "python is too old"
if ! sql "select 1" >/dev/null 2>&1; then bad "cannot query database $DB as postgres"; exit 1; fi
[ "$(sql "select current_setting('server_version_num')::int >= 150000")" = t ] && ok "PostgreSQL 15 or newer" || bad "PostgreSQL older than 15"
[ "$(sql "select count(*) from pg_extension where extname='postgis'")" = 1 ] && ok "PostGIS installed" || bad "PostGIS missing"
views=$(sql "select count(*) from pg_matviews where matviewname like 'mv\_' || schemaname || '\_%'")
[ "$views" -gt 0 ] && ok "$views city views found (<city>.mv_<city>_*)" || bad "no <city>.mv_<city>_* views in $DB"
[ "$(sql "select count(*) from pg_roles where rolname='$OSUSER'")" = 0 ] && ok "role $OSUSER does not exist yet" || bad "role $OSUSER already exists: already installed?"
[ ! -e "$HOME_DIR" ] && ok "$HOME_DIR is free" || bad "$HOME_DIR already exists"
data=$(sql "show data_directory")
free=$(df -BG --output=avail "$data" | tail -1 | tr -dc '0-9')
[ "$free" -ge 20 ] && ok "${free} GB free for the database" || bad "only ${free} GB free, 20 needed"
hba=$(sql "show hba_file")
ok "pg_hba file: $hba"
last_dump=$(find /var/backups -maxdepth 3 -type f \( -name '*.dump' -o -name '*.sql' -o -name '*.sql.gz' \) -mtime -2 2>/dev/null | head -1)
[ -n "$last_dump" ] && ok "a backup from the last 2 days exists: $last_dump" || echo "WARN  no database backup from the last 2 days under /var/backups"

[ $fail = 0 ] || { echo "checks failed, nothing changed"; exit 1; }
if [ $APPLY = 0 ]; then
  echo
  echo "check only, nothing changed. With --apply this will:"
  echo "  1. create the system user $OSUSER (no login shell)"
  echo "  2. copy the job to $HOME_DIR and write $ETC/config.json"
  echo "  3. capture the current view definitions into $HOME_DIR/definitions (database is only read)"
  echo "  4. add 4 lines at the top of $hba (a copy is kept) and reload PostgreSQL, no restart"
  echo "  5. create role $OSUSER and schemas mv_sync, mv_sync_build in $DB"
  echo "  6. install and start the systemd timer mv-sync.timer, mode = observe"
  exit 0
fi

# ------------------------------------------------------------------ apply
trap 'echo "INSTALL FAILED part way. Undo with: bash uninstall.sh --database $DB"' ERR
echo "== 1 system user"
id "$OSUSER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$OSUSER"

echo "== 2 files"
install -d -m 755 "$HOME_DIR" "$HOME_DIR/sql" "$ETC"
install -m 644 "$SRC"/{mvsync.py,rules.py,capture.py,compare.py,config.example.json,README.md} "$HOME_DIR/"
install -m 644 "$SRC"/sql/* "$HOME_DIR/sql/"
python3 - "$HOME_DIR/config.example.json" "$ETC/config.json" "$DB" "$data" <<'PY'
import json, sys
src, dst, db, data = sys.argv[1:]
cfg = json.load(open(src))
cfg.update(database=db, disk_path=data)
json.dump(cfg, open(dst, "w"), indent=2)
PY
chmod 644 "$ETC/config.json"

echo "== 3 view definitions"
install -d -o postgres -m 755 "$HOME_DIR/definitions"
sudo -n -u postgres env PYTHONDONTWRITEBYTECODE=1 python3 "$HOME_DIR/capture.py" --local --database "$DB"
chown -R root:root "$HOME_DIR/definitions"
chmod -R a+rX "$HOME_DIR"

echo "== 4 pg_hba"
if ! grep -q "^# BEGIN mv-sync$" "$hba"; then
  copy="$hba.before-mv-sync.$(date +%Y%m%d%H%M%S)"
  cp -p "$hba" "$copy"
  tmp=$(mktemp)
  # the markers let uninstall.sh remove exactly these lines and nothing else
  { echo "# BEGIN mv-sync"; sed "s/\bnv_allnndb\b/$DB/" "$SRC/sql/pg_hba.mv_sync.conf"; echo "# END mv-sync"; cat "$copy"; } > "$tmp"
  cat "$tmp" > "$hba"   # keeps owner and mode
  rm -f "$tmp"
  if [ "$(sql "select count(*) from pg_hba_file_rules where error is not null")" != 0 ]; then
    cat "$copy" > "$hba"
    echo "pg_hba would have errors, restored the original"; exit 1
  fi
  sql "select pg_reload_conf()" >/dev/null
  echo "added; original kept at $copy"
fi

echo "== 5 database objects"
sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HOME_DIR/sql/install.sql"
sudo -n -u "$OSUSER" psql -X -qAt -d "$DB" -c "select 'job login works: ' || current_user"

echo "== 6 timer"
install -m 644 "$SRC"/systemd/mv-sync.service "$SRC"/systemd/mv-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start mv-sync.service
systemctl enable --now mv-sync.timer
sudo -n -u "$OSUSER" env PYTHONDONTWRITEBYTECODE=1 python3 "$HOME_DIR/mvsync.py" status | head -1
echo
echo "installed in observe mode. Watch: journalctl -u mv-sync -f   and table mv_sync.run_log"
echo "tile cache clearing is not set up yet: see README, 'Install on a server'"
