-- bkh-wait schema v4. Applied by scripts/db-migrate.mjs (owner account,
-- search_path = wait, one transaction). Never edit after it was applied.
--
-- occupancy_snapshot is written by the sync worker (bkh_wait_sync, db/003)
-- only; the web app (bkh_wait_app) just reads it. Kept apart from db/003 so
-- scripts/server-upgrade-sync.sh can apply it after the first sync worked
-- and the old cron (POST /api/snapshot as bkh_wait_app) was replaced:
-- a failed upgrade then leaves the old install fully working. Rows are kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON occupancy_snapshot FROM bkh_wait_app;
    GRANT SELECT ON occupancy_snapshot TO bkh_wait_app;
  END IF;
END
$$;
