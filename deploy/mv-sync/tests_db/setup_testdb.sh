#!/usr/bin/env bash
# Build the throwaway database mv_sync_test from copies of some city schemas.
# Run on the database server as a user allowed to "sudo -u postgres". The source database is only read.
#   bash setup_testdb.sh SOURCE_DB FIRST_CITY [MORE_CITIES...]
# Only FIRST_CITY is activated; the scenarios activate the others. Remove with teardown_testdb.sh.
set -euo pipefail
DB=mv_sync_test
SRC=$1
shift
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd /tmp
pg() { sudo -n -u postgres "$@"; }

exists=$(pg psql -X -qAt -d template1 -c "select (select count(*) from pg_database where datname='$DB') + (select count(*) from pg_roles where rolname='mv_sync_job')")
[ "$exists" = "0" ] || { echo "database $DB or role mv_sync_job already exists, not touching them"; exit 1; }

pg psql -X -qAt -v ON_ERROR_STOP=1 -d template1 \
  -c "CREATE DATABASE $DB TEMPLATE template0" -c "REVOKE CONNECT ON DATABASE $DB FROM PUBLIC"
pg psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB" -c "CREATE EXTENSION postgis"
# the application roles hold grants on the views; give them CONNECT so grant checks are realistic
pg psql -X -qAt -d template1 -c "select format('GRANT CONNECT ON DATABASE $DB TO %I;', rolname) from pg_roles where rolname like '$SRC\_%'"   | pg psql -X -q -v ON_ERROR_STOP=1 -d template1

for city in "$@"; do
  echo "copying schema $city"
  pg pg_dump -d "$SRC" -n "$city" | pg psql -X -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null
done

# the test database does not need the pg_hba restriction: the job runs here through "role" only
pg psql -X -q -v ON_ERROR_STOP=1 -v skip_hba_check=1 -d "$DB" -f "$HERE/sql/install.sql"
pg psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -v city="$1" -f "$HERE/sql/activate_city.sql"
echo "test database ready"
