-- Creates the job's own role, schemas and tables. Run once as a superuser, directly on PostgreSQL.
-- Does not touch any existing table or view.  Undo: uninstall.sql
\set ON_ERROR_STOP on

-- Refuse to install unless pg_hba.conf keeps mv_sync_job to one database (see pg_hba.mv_sync.conf).
-- A throwaway test database may skip this with: psql -v skip_hba_check=1
\if :{?skip_hba_check}
\echo 'WARNING: pg_hba check skipped, use only for a test database'
\else
DO $check$
DECLARE t text; reject_at integer; open_rules integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL) THEN
    RAISE EXCEPTION 'pg_hba.conf has errors';
  END IF;
  FOREACH t IN ARRAY ARRAY['local', 'host'] LOOP
    SELECT min(rule_number) INTO reject_at FROM pg_hba_file_rules
     WHERE type LIKE t || '%' AND auth_method = 'reject'
       AND 'mv_sync_job' = ANY (user_name) AND 'all' = ANY (database);
    IF reject_at IS NULL THEN
      RAISE EXCEPTION 'pg_hba.conf has no % reject rule for mv_sync_job on all databases', t;
    END IF;
    -- no earlier rule may let this user into another database
    SELECT count(*) INTO open_rules FROM pg_hba_file_rules
     WHERE type LIKE t || '%' AND rule_number < reject_at AND auth_method <> 'reject'
       AND user_name && ARRAY['all', 'mv_sync_job'] AND database <> ARRAY[current_database()::text]
       AND NOT database <@ ARRAY['replication'];
    IF open_rules > 0 THEN
      RAISE EXCEPTION '% % rule(s) above the reject rule still admit mv_sync_job elsewhere', open_rules, t;
    END IF;
  END LOOP;
END $check$;
\endif

BEGIN;

CREATE ROLE mv_sync_job LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT pg_read_all_data TO mv_sync_job;      -- also covers tables imported or renamed later
GRANT pg_read_all_stats TO mv_sync_job;     -- to notice a running pg_dump

CREATE SCHEMA mv_sync AUTHORIZATION mv_sync_job;
CREATE SCHEMA mv_sync_build AUTHORIZATION mv_sync_job;  -- app and GeoServer get no access
SET ROLE mv_sync_job;

CREATE TABLE mv_sync.control (
  only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('off', 'observe', 'on')),
  last_run_at timestamptz
);
INSERT INTO mv_sync.control DEFAULT VALUES;

CREATE TABLE mv_sync.enabled_city (city text PRIMARY KEY);  -- cities the job may rebuild
CREATE TABLE mv_sync.paused_city (city text PRIMARY KEY);

CREATE TABLE mv_sync.view_state (
  view_name text PRIMARY KEY,
  city text NOT NULL,
  seen_sig text, built_sig text, rejected_sig text, logged_sig text,
  first_change_at double precision, last_change_at double precision, last_success_at double precision,
  fail_count integer NOT NULL DEFAULT 0,
  held boolean NOT NULL DEFAULT false,
  held_reason text,
  accept_rows boolean NOT NULL DEFAULT false,
  expected_oid bigint, -- the view object the job knows; another one means someone else changed it
  retry_after double precision  -- backing off after a busy lock or a failure
);

CREATE TABLE mv_sync.run_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  view_name text, action text NOT NULL, detail text, ms integer
);
CREATE INDEX ON mv_sync.run_log (action, view_name, at);

CREATE TABLE mv_sync.cache_queue (
  id bigserial PRIMARY KEY, layer text NOT NULL, queued_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;
COMMIT;
