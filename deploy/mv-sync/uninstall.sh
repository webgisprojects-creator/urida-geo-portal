#!/usr/bin/env bash
# Remove the sync job: sudo bash uninstall.sh --database NAME
# Views stay as they are; their ownership returns to postgres.
set -euo pipefail
[ "${1:-}" = "--database" ] && [[ ${2:-} =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "usage: uninstall.sh --database NAME"; exit 2; }
DB=$2
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
cd /tmp
sql() { sudo -n -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

systemctl disable --now mv-sync.timer 2>/dev/null || true
systemctl stop mv-sync.service 2>/dev/null || true
if [ "$(sql "select count(*) from pg_namespace where nspname='mv_sync'")" = 1 ]; then
  for city in $(sql "select city from mv_sync.enabled_city"); do
    sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -v city="$city" -f "$SRC/sql/deactivate_city.sql"
  done
  sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$SRC/sql/uninstall.sql"
fi
rm -f /etc/systemd/system/mv-sync.service /etc/systemd/system/mv-sync.timer
systemctl daemon-reload
hba=$(sql "show hba_file")
if grep -q "^# BEGIN mv-sync$" "$hba" && grep -q "^# END mv-sync$" "$hba"; then
  cp -p "$hba" "$hba.before-mv-sync-removal.$(date +%Y%m%d%H%M%S)"
  tmp=$(mktemp)
  sed '/^# BEGIN mv-sync$/,/^# END mv-sync$/d' "$hba" > "$tmp"
  cat "$tmp" > "$hba"; rm -f "$tmp"
  [ "$(sql "select count(*) from pg_hba_file_rules where error is not null")" = 0 ] || { echo "check $hba: it has errors"; exit 1; }
  sql "select pg_reload_conf()" >/dev/null
elif grep -q "mv_sync_job" "$hba"; then
  echo "WARNING: $hba mentions mv_sync_job without the mv-sync markers: remove those lines by hand"
fi
id mv_sync_job >/dev/null 2>&1 && userdel mv_sync_job
rm -rf -- /opt/mv-sync /etc/mv-sync
echo "removed"
