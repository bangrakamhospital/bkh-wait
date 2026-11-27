-- bkh-wait schema v9: OPD wait segments the way auditors measure them.
-- Applied by scripts/db-migrate.mjs (owner account, search_path = wait,
-- one transaction). Never edit after it was applied: add 010_*.sql.
--
--   screening -> doctor   doctor exam start (first OPD-DOCTOR at a clinic)
--                         - the latest OPD-SCREEN begin at or before it
--   doctor -> medicine    first rx_dispenser_detail type 4 (ผู้จ่ายยา, drugs
--                         handed over) - doctor exam end; seen visits with
--                         a drug item only
-- Definitions: scripts/lib/hosxp-opd.mjs header "Wait segments" and
-- docs/api.md. Values < 0 or > 480 min are left out and only counted
-- (*_excluded). The registration -> doctor columns of db/005 stay as they
-- are (central API backward compatibility).
--
-- Written ONLY by the OPD sync worker (role bkh_wait_sync; table-level
-- grants of db/005 cover the new columns). Aggregates only: the arrays
-- are anonymous sorted minutes, as wait_minutes in db/005.
-- Days finalized before this migration have empty arrays until the worker
-- runs with --resegment=N.

ALTER TABLE opd_state
  ADD COLUMN screen_wait_minutes integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN screen_excluded     integer NOT NULL DEFAULT 0
    CONSTRAINT opd_state_screen_excluded_nonneg CHECK (screen_excluded >= 0),
  ADD COLUMN rx_wait_minutes     integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN rx_excluded         integer NOT NULL DEFAULT 0
    CONSTRAINT opd_state_rx_excluded_nonneg CHECK (rx_excluded >= 0),
  -- seen today with at least one drug item (denominator of the rx fill rate)
  ADD COLUMN seen_with_rx        integer NOT NULL DEFAULT 0
    CONSTRAINT opd_state_seen_with_rx_nonneg CHECK (seen_with_rx >= 0),
  -- longest (now - screening) of those waiting now who were screened; NULL = none
  ADD COLUMN longest_screen_wait_minutes integer
    CONSTRAINT opd_state_longest_screen_nonneg CHECK (longest_screen_wait_minutes IS NULL OR longest_screen_wait_minutes >= 0);

ALTER TABLE opd_hourly
  -- screening -> doctor of the visits seen in this hour (kept values only)
  ADD COLUMN screen_wait_sum integer NOT NULL DEFAULT 0
    CONSTRAINT opd_hourly_screen_sum_nonneg CHECK (screen_wait_sum >= 0),
  ADD COLUMN screen_wait_n   integer NOT NULL DEFAULT 0
    CONSTRAINT opd_hourly_screen_n_nonneg CHECK (screen_wait_n >= 0);
ALTER TABLE opd_hourly
  ADD CONSTRAINT opd_hourly_screen_n_range CHECK (screen_wait_n <= seen);

ALTER TABLE opd_daily
  ADD COLUMN screen_wait_minutes integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN screen_excluded     integer NOT NULL DEFAULT 0
    CONSTRAINT opd_daily_screen_excluded_nonneg CHECK (screen_excluded >= 0),
  ADD COLUMN rx_wait_minutes     integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN rx_excluded         integer NOT NULL DEFAULT 0
    CONSTRAINT opd_daily_rx_excluded_nonneg CHECK (rx_excluded >= 0),
  ADD COLUMN seen_with_rx        integer NOT NULL DEFAULT 0
    CONSTRAINT opd_daily_seen_with_rx_nonneg CHECK (seen_with_rx >= 0),
  -- when the segment columns were computed (NULL: day finalized before db/009)
  ADD COLUMN segments_at         timestamptz;
