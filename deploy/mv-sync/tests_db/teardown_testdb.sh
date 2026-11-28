#!/usr/bin/env bash
# Remove the throwaway test database and the job role it created.
set -euo pipefail
cd /tmp
pg() { sudo -n -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d template1 -c "$1"; }
pg "DROP DATABASE IF EXISTS mv_sync_test WITH (FORCE)"
pg "DROP ROLE IF EXISTS mv_sync_job"
pg "select 'left over: databases ' || (select count(*) from pg_database where datname='mv_sync_test') || ', roles ' || (select count(*) from pg_roles where rolname='mv_sync_job')"
