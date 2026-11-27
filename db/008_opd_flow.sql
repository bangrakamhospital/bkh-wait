-- bkh-wait schema v8: OPD visit flow — where every visit of the day is now.
-- Applied by scripts/db-migrate.mjs (owner account, search_path = wait,
-- one transaction). Never edit after it was applied: add 009_*.sql.
--
-- Written ONLY by the OPD sync worker (scripts/sync-opd.mjs, every 5 min
-- 06:00-20:55, role bkh_wait_sync): today's rows are replaced as a whole
-- every run, in the same transaction as opd_state. Earlier days keep the
-- last snapshot of that day (the 20:55 run). Read by the web app (role
-- bkh_wait_app, src/lib/opd/board.ts).
--
-- Every ovst row of the day (ER included) is in exactly ONE bucket, so the
-- buckets of a day sum to COUNT(*) FROM ovst WHERE vstdate = visit_date —
-- the bkh-kpi "visit ผู้ป่วยนอก" number. Definitions (first match wins):
-- scripts/lib/hosxp-opd.mjs "Visit flow" and docs/api.md. Aggregates only.

CREATE TABLE opd_flow (
  visit_date  date NOT NULL,
  bucket      text NOT NULL
    CONSTRAINT opd_flow_bucket_valid CHECK (bucket IN (
      'screening', 'doctor', 'after_doctor', 'lab', 'services',
      'pharmacy', 'done', 'er', 'admit', 'other')),
  visits      integer NOT NULL CONSTRAINT opd_flow_visits_nonneg CHECK (visits >= 0),
  sync_run_id bigint NOT NULL REFERENCES sync_run (id),
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (visit_date, bucket)
);

-- ---------------------------------------------------------------------------
-- Privileges (least privilege), same pattern as db/005.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON opd_flow TO bkh_wait_sync;
  ELSE
    RAISE WARNING 'role bkh_wait_sync does not exist: create it (scripts/db-sync-role.sh), then re-run the GRANTs of db/008_opd_flow.sql';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON opd_flow FROM bkh_wait_app;
    GRANT SELECT ON opd_flow TO bkh_wait_app;
  END IF;
END
$$;
