-- bkh-wait schema v5: OPD "waiting to see a doctor" per clinic. Applied by
-- scripts/db-migrate.mjs (owner account, search_path = wait, one
-- transaction). Never edit after it was applied.
--
-- Written ONLY by the OPD sync worker (scripts/sync-opd.mjs, cron every
-- 5 min 06:00-20:55, role bkh_wait_sync); read by the web app
-- (role bkh_wait_app, src/lib/opd/*). Definitions: scripts/lib/hosxp-opd.mjs
-- and docs/api.md "OPD". Aggregates only: no HN / VN / names / doctor codes.
-- The wait_minutes arrays are anonymous lists of minutes (sorted), kept so
-- the app can compute medians over any set of visible clinics exactly.

-- ---------------------------------------------------------------------------
-- sync_run is shared with the bed sync: job tells them apart. Existing rows
-- and the bed worker (which does not send job) stay 'beds'.
-- ---------------------------------------------------------------------------
ALTER TABLE sync_run ADD COLUMN job text NOT NULL DEFAULT 'beds'
  CONSTRAINT sync_run_job_valid CHECK (job IN ('beds', 'opd'));
CREATE INDEX sync_run_job_ok_finished_idx ON sync_run (job, finished_at DESC) WHERE ok;

-- ---------------------------------------------------------------------------
-- HOSxP master data: doctor-exam clinics (kskdepartment depcodes with
-- OPD-DOCTOR rows in the last 28 days, non-doctor points excluded).
-- ---------------------------------------------------------------------------
CREATE TABLE his_opd_clinic (
  clinic_code text PRIMARY KEY
    CONSTRAINT his_opd_clinic_code_format CHECK (clinic_code ~ '^[0-9A-Za-z]{1,3}$'),
  his_name    text NOT NULL,
  -- seen a doctor exam in the last 28 days (at the last route refresh)
  active      boolean NOT NULL,
  -- doctor exams in the last 28 days (default ordering)
  visits_28d  integer NOT NULL DEFAULT 0 CONSTRAINT his_opd_clinic_visits_nonneg CHECK (visits_28d >= 0),
  synced_at   timestamptz NOT NULL
);

-- Learned route: department (main_dep / cur_dep) -> clinic where most of its
-- visits saw a doctor in the last 28 days (only when >= 50 % of them did).
CREATE TABLE opd_route (
  from_dep     text PRIMARY KEY,
  clinic_code  text NOT NULL,
  visits       integer NOT NULL CONSTRAINT opd_route_visits_nonneg CHECK (visits >= 0),
  seen_share   numeric(5, 4) NOT NULL CONSTRAINT opd_route_share_range CHECK (seen_share BETWEEN 0 AND 1),
  computed_at  timestamptz NOT NULL
);

-- Staff overrides (SQL only for now): rename / hide / order clinics.
CREATE TABLE opd_clinic_config (
  clinic_code  text PRIMARY KEY
    CONSTRAINT opd_clinic_config_code_format CHECK (clinic_code ~ '^[0-9A-Za-z]{1,3}$'),
  display_name text
    CONSTRAINT opd_clinic_config_name_len CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 80),
  visible      boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 1000,
  updated_by   text NOT NULL DEFAULT 'system',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Current state per clinic (result of the last successful OPD sync;
-- replaced as a whole every run).
-- ---------------------------------------------------------------------------
CREATE TABLE opd_state (
  clinic_code          text PRIMARY KEY REFERENCES his_opd_clinic (clinic_code) ON DELETE CASCADE,
  sync_run_id          bigint NOT NULL REFERENCES sync_run (id),
  visit_date           date NOT NULL,
  waiting_now          integer NOT NULL CONSTRAINT opd_state_waiting_nonneg CHECK (waiting_now >= 0),
  waiting_for_doctor   integer NOT NULL
    CONSTRAINT opd_state_wfd_range CHECK (waiting_for_doctor BETWEEN 0 AND waiting_now),
  longest_wait_minutes integer NOT NULL CONSTRAINT opd_state_longest_nonneg CHECK (longest_wait_minutes >= 0),
  seen_today           integer NOT NULL CONSTRAINT opd_state_seen_nonneg CHECK (seen_today >= 0),
  visits_today         integer NOT NULL CONSTRAINT opd_state_visits_nonneg CHECK (visits_today >= 0),
  seen_last_hour       integer NOT NULL CONSTRAINT opd_state_slh_nonneg CHECK (seen_last_hour >= 0),
  doctors_active       integer NOT NULL CONSTRAINT opd_state_doctors_nonneg CHECK (doctors_active >= 0),
  -- registration -> doctor minutes of today's seen visits (<= 720), sorted
  wait_minutes         integer[] NOT NULL DEFAULT '{}'
);

-- Per (date, clinic, hour 0-23): registrations, doctor exam starts and the
-- wait of those seen in that hour. Today's rows are replaced every run;
-- earlier days are recomputed once when finalized (opd_daily).
CREATE TABLE opd_hourly (
  visit_date  date NOT NULL,
  clinic_code text NOT NULL,
  hour        smallint NOT NULL CONSTRAINT opd_hourly_hour_range CHECK (hour BETWEEN 0 AND 23),
  arrived     integer NOT NULL CONSTRAINT opd_hourly_arrived_nonneg CHECK (arrived >= 0),
  seen        integer NOT NULL CONSTRAINT opd_hourly_seen_nonneg CHECK (seen >= 0),
  -- sum / count of waits (<= 720 min) of the visits seen in this hour
  wait_sum    integer NOT NULL CONSTRAINT opd_hourly_wait_sum_nonneg CHECK (wait_sum >= 0),
  wait_n      integer NOT NULL CONSTRAINT opd_hourly_wait_n_range CHECK (wait_n BETWEEN 0 AND seen),
  PRIMARY KEY (visit_date, clinic_code, hour)
);

-- Daily summary per (date, clinic), Asia/Bangkok dates. Today's row is
-- updated by every run; at the first run of a later day it is recomputed
-- from HOSxP for the whole day, finalized_at set, and never changes again.
CREATE TABLE opd_daily (
  visit_date     date NOT NULL,
  clinic_code    text NOT NULL,
  clinic_name    text NOT NULL,
  visits         integer NOT NULL CONSTRAINT opd_daily_visits_nonneg CHECK (visits >= 0),
  seen           integer NOT NULL CONSTRAINT opd_daily_seen_nonneg CHECK (seen >= 0),
  avg_wait       numeric(7, 1),
  median_wait    numeric(7, 1),
  p90_wait       numeric(7, 1),
  within60_pct   numeric(5, 1) CONSTRAINT opd_daily_within60_range CHECK (within60_pct IS NULL OR within60_pct BETWEEN 0 AND 100),
  wait_minutes   integer[] NOT NULL DEFAULT '{}',
  finalized_at   timestamptz,
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (visit_date, clinic_code)
);
CREATE INDEX opd_daily_open_idx ON opd_daily (visit_date) WHERE finalized_at IS NULL;

-- Clinics with overrides applied: the ONE definition of name / visibility /
-- order, used by src/lib/opd/*.
CREATE VIEW opd_clinic_catalog AS
SELECT h.clinic_code,
       h.his_name,
       h.active,
       h.visits_28d,
       coalesce(nullif(btrim(c.display_name), ''), h.his_name) AS clinic_name,
       coalesce(c.visible, true)                               AS visible,
       coalesce(c.sort_order, 1000)                            AS sort_order
  FROM his_opd_clinic h
  LEFT JOIN opd_clinic_config c ON c.clinic_code = h.clinic_code;

-- ---------------------------------------------------------------------------
-- Privileges (least privilege), same pattern as db/003.
--   bkh_wait_sync: write the OPD copies, read opd_clinic_config.
--   bkh_wait_app:  read them; opd_clinic_config read-write (staff overrides).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    GRANT SELECT ON opd_clinic_config, opd_clinic_catalog TO bkh_wait_sync;
    GRANT SELECT, INSERT, UPDATE, DELETE ON his_opd_clinic, opd_route, opd_state, opd_hourly, opd_daily
      TO bkh_wait_sync;
  ELSE
    RAISE WARNING 'role bkh_wait_sync does not exist: create it (scripts/db-sync-role.sh), then re-run the GRANTs of db/005_opd.sql';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON his_opd_clinic, opd_route, opd_state, opd_hourly, opd_daily, opd_clinic_catalog
      FROM bkh_wait_app;
    GRANT SELECT ON his_opd_clinic, opd_route, opd_state, opd_hourly, opd_daily, opd_clinic_catalog
      TO bkh_wait_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON opd_clinic_config TO bkh_wait_app;
  END IF;
END
$$;
