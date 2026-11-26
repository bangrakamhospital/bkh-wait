-- bkh-wait schema v2. Applied by scripts/db-migrate.mjs (owner account,
-- search_path = wait, one transaction). Never edit after it was applied.

-- Beds in use (เตียงคนนอน) at snapshot time. NULL = row taken before this
-- migration (only occupied / beds were recorded then).
ALTER TABLE occupancy_snapshot
  ADD COLUMN beds_in_use integer
    CONSTRAINT occupancy_snapshot_beds_in_use_range
      CHECK (beds_in_use IS NULL OR (beds_in_use >= 0 AND beds_in_use <= occupied));

-- schema_migrations is created by the owner, so the default privileges of
-- db/setup.sql gave the web app SELECT/INSERT/UPDATE/DELETE on it. Only the
-- migration script (owner) may write it; the app keeps SELECT. Skipped when
-- the app role does not exist (e.g. a dev database without db/setup.sql).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM bkh_wait_app;
  END IF;
END
$$;
