-- Lets the job rebuild one city's views: psql -v city=ghaziabad -f activate_city.sql  (superuser)
-- Only ownership changes; existing grants stay.  Undo: deactivate_city.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT USAGE, CREATE ON SCHEMA :"city" TO mv_sync_job;
SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO mv_sync_job', schemaname, matviewname)
  FROM pg_matviews WHERE schemaname = :'city' AND matviewname LIKE 'mv\_' || :'city' || '\_%'
\gexec
INSERT INTO mv_sync.enabled_city VALUES (:'city') ON CONFLICT DO NOTHING;
-- have every view of the city checked against current data on the next runs
UPDATE mv_sync.view_state SET last_success_at = NULL, retry_after = NULL WHERE city = :'city';
COMMIT;
