-- Takes one city back from the job: psql -v city=ghaziabad -f deactivate_city.sql  (superuser)
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DELETE FROM mv_sync.enabled_city WHERE city = :'city';
SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO postgres', schemaname, matviewname)
  FROM pg_matviews WHERE schemaname = :'city' AND matviewowner = 'mv_sync_job'
\gexec
REVOKE CREATE ON SCHEMA :"city" FROM mv_sync_job;
COMMIT;
