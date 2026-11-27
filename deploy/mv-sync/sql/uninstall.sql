-- Removes the job. Run deactivate_city.sql for every enabled city first. (superuser)
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewowner = 'mv_sync_job' AND schemaname <> 'mv_sync_build') THEN
    RAISE EXCEPTION 'views are still owned by mv_sync_job: deactivate those cities first';
  END IF;
END $$;
DROP SCHEMA mv_sync_build CASCADE;
DROP SCHEMA mv_sync CASCADE;
DROP OWNED BY mv_sync_job;  -- remaining schema grants only
DROP ROLE mv_sync_job;
COMMIT;
