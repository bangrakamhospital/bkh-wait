-- bkh-wait schema v3: HOSxP sync tables. Applied by scripts/db-migrate.mjs
-- (owner account, search_path = wait, one transaction). Never edit after it
-- was applied.
--
-- From v3 on the web app never connects to HOSxP. The sync worker
-- (scripts/sync-hosxp.mjs, cron every 15 min, role bkh_wait_sync) copies
-- aggregate counts into the tables below; the web app (role bkh_wait_app)
-- only reads them. Nothing here holds patient identifiers.

-- ---------------------------------------------------------------------------
-- HOSxP master data (copied on every sync).
-- ---------------------------------------------------------------------------
CREATE TABLE his_ward (
  ward_code           text PRIMARY KEY
    CONSTRAINT his_ward_code_format CHECK (ward_code ~ '^[0-9A-Za-z]{1,4}$'),
  his_name            text NOT NULL,
  -- physical beds (bedno JOIN roomno per roomno.ward), else ward.bedcount
  his_beds            integer NOT NULL CONSTRAINT his_ward_beds_nonneg CHECK (his_beds >= 0),
  -- ward.ward_active = 'Y' at the last sync
  active              boolean NOT NULL,
  -- most frequent ipt.spclty of the last 365 days (fallback department)
  dominant_spclty_code text,
  dominant_at         timestamptz,
  synced_at           timestamptz NOT NULL
);

CREATE TABLE his_spclty (
  spclty_code text PRIMARY KEY,
  name        text NOT NULL,
  synced_at   timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- One row per sync run (ok or failed). error_code is a short code such as
-- HIS_ECONNREFUSED or PG_57014 — never a message, host or credential.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  ok          boolean NOT NULL,
  error_code  text CONSTRAINT sync_run_error_code_len CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  -- HOSxP clock at read time
  his_today   date,
  wards       integer,
  CONSTRAINT sync_run_ok_no_error CHECK (ok = (error_code IS NULL))
);
CREATE INDEX sync_run_ok_finished_idx ON sync_run (finished_at DESC) WHERE ok;

-- ---------------------------------------------------------------------------
-- Current state = result of the last successful sync (replaced each run).
-- ---------------------------------------------------------------------------
CREATE TABLE ward_state (
  ward_code        text PRIMARY KEY REFERENCES his_ward (ward_code) ON DELETE CASCADE,
  sync_run_id      bigint NOT NULL REFERENCES sync_run (id),
  occupied         integer NOT NULL CONSTRAINT ward_state_occupied_nonneg CHECK (occupied >= 0),
  beds_in_use      integer NOT NULL
    CONSTRAINT ward_state_beds_in_use_range CHECK (beds_in_use >= 0 AND beds_in_use <= occupied),
  admitted_today   integer NOT NULL CONSTRAINT ward_state_admitted_nonneg CHECK (admitted_today >= 0),
  discharged_today integer NOT NULL CONSTRAINT ward_state_discharged_nonneg CHECK (discharged_today >= 0)
);

CREATE TABLE ward_spclty_state (
  ward_code   text NOT NULL REFERENCES his_ward (ward_code) ON DELETE CASCADE,
  -- '' = no spclty recorded in ipt
  spclty_code text NOT NULL,
  occupied    integer NOT NULL CONSTRAINT ward_spclty_state_occupied_pos CHECK (occupied > 0),
  PRIMARY KEY (ward_code, spclty_code)
);

-- ---------------------------------------------------------------------------
-- Daily census per (date, ward), Asia/Bangkok dates. Non-virtual wards only.
-- Today's row is updated by every sync; at the first sync of the next day
-- the row is finalized (admitted / discharged / patient_days recomputed
-- from HOSxP for the whole day, finalized_at set) and never changes again.
-- ward_name / department_* / beds are the values at the time of the sync.
-- ---------------------------------------------------------------------------
CREATE TABLE daily_census (
  census_date      date NOT NULL,
  ward_code        text NOT NULL,
  ward_name        text NOT NULL,
  department_code  text NOT NULL,
  department_name  text NOT NULL,
  beds             integer NOT NULL CONSTRAINT daily_census_beds_nonneg CHECK (beds >= 0),
  beds_in_use      integer NOT NULL CONSTRAINT daily_census_in_use_nonneg CHECK (beds_in_use >= 0),
  peak_beds_in_use integer NOT NULL
    CONSTRAINT daily_census_peak_range CHECK (peak_beds_in_use >= beds_in_use),
  admitted         integer NOT NULL CONSTRAINT daily_census_admitted_nonneg CHECK (admitted >= 0),
  discharged       integer NOT NULL CONSTRAINT daily_census_discharged_nonneg CHECK (discharged >= 0),
  patient_days     integer NOT NULL CONSTRAINT daily_census_patient_days_nonneg CHECK (patient_days >= 0),
  finalized_at     timestamptz,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (census_date, ward_code)
);
CREATE INDEX daily_census_open_idx ON daily_census (census_date) WHERE finalized_at IS NULL;

-- ---------------------------------------------------------------------------
-- HOSxP wards with ward_config applied: the ONE definition of ward name,
-- capacity, visibility, virtual flag and department, used by the board
-- (src/lib/beds/board.ts), the settings API and the sync worker.
--   department: ward_config.department_code -> wait.department; a ward with
--   a config row but no department -> '_none'; a ward without a config row
--   -> its dominant spclty ('sp-<code>'), else '_none'.
--   virtual default without a config row: ward 17 (Home Ward); keep in sync
--   with DEFAULT_VIRTUAL_WARDS in src/lib/beds/config.ts.
-- ---------------------------------------------------------------------------
CREATE VIEW ward_catalog AS
SELECT h.ward_code,
       h.his_name,
       h.his_beds,
       h.active,
       (c.ward_code IS NOT NULL)                              AS has_config,
       c.display_name,
       c.bed_capacity,
       c.department_code                                      AS config_department_code,
       coalesce(nullif(btrim(c.display_name), ''), h.his_name) AS ward_name,
       coalesce(c.bed_capacity, h.his_beds)                   AS beds,
       coalesce(c.visible, true)                              AS visible,
       coalesce(c.is_virtual, h.ward_code = '17')             AS is_virtual,
       coalesce(c.sort_order, 1000)                           AS sort_order,
       CASE WHEN d.department_code IS NOT NULL THEN d.department_code
            WHEN c.ward_code IS NULL AND h.dominant_spclty_code IS NOT NULL
              THEN 'sp-' || h.dominant_spclty_code
            ELSE '_none' END                                  AS department_code,
       CASE WHEN d.department_code IS NOT NULL THEN d.name
            WHEN c.ward_code IS NULL AND h.dominant_spclty_code IS NOT NULL
              THEN coalesce(s.name, 'แผนก ' || h.dominant_spclty_code)
            ELSE 'ไม่ระบุแผนก' END                              AS department_name,
       CASE WHEN d.department_code IS NOT NULL THEN d.sort_order
            WHEN c.ward_code IS NULL AND h.dominant_spclty_code IS NOT NULL THEN 5000
            ELSE 2147483647 END                               AS department_sort
  FROM his_ward h
  LEFT JOIN ward_config c ON c.ward_code = h.ward_code
  LEFT JOIN department d ON d.department_code = c.department_code
  LEFT JOIN his_spclty s ON s.spclty_code = h.dominant_spclty_code;

-- ---------------------------------------------------------------------------
-- Privileges (least privilege).
--   bkh_wait_sync (worker): read config, write the sync tables + snapshots.
--     No access to refer_back_request, audit_log or users of the web app.
--   bkh_wait_app (web): read the sync tables (occupancy_snapshot becomes
--     read-only in db/004, after the upgrade switched the cron).
-- The owner role has no CREATEROLE (db/setup.sql), so on a normal install
-- bkh_wait_sync is created by db/sync-role.sql. If it is missing and the
-- migrating role may create roles (superuser on a dev box), it is created
-- here WITHOUT login; give it one with
--   ALTER ROLE bkh_wait_sync LOGIN PASSWORD '...';
-- Otherwise the grants are skipped with a warning.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  can_create boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    SELECT rolsuper OR rolcreaterole INTO can_create FROM pg_roles WHERE rolname = current_user;
    IF can_create THEN
      CREATE ROLE bkh_wait_sync NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT
        CONNECTION LIMIT 3;
      RAISE NOTICE 'created role bkh_wait_sync without login: ALTER ROLE bkh_wait_sync LOGIN PASSWORD ...';
    ELSE
      RAISE WARNING 'role bkh_wait_sync does not exist and % cannot create roles: create it as postgres (scripts/db-sync-role.sh), then re-run the GRANTs of db/003_hosxp_sync.sql', current_user;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO bkh_wait_sync', current_database());
    GRANT USAGE ON SCHEMA wait TO bkh_wait_sync;
    GRANT SELECT ON ward_config, department, ward_catalog TO bkh_wait_sync;
    GRANT SELECT, INSERT, UPDATE, DELETE ON his_ward, his_spclty, ward_state, ward_spclty_state, daily_census
      TO bkh_wait_sync;
    GRANT SELECT, INSERT ON sync_run, occupancy_snapshot TO bkh_wait_sync;
    GRANT USAGE, SELECT ON SEQUENCE sync_run_id_seq TO bkh_wait_sync;
    -- search_path / time zone are sent by the worker at connect time (the
    -- owner may not ALTER ROLE; db/setup.sql sets role defaults on new installs).
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    -- default privileges (db/setup.sql) granted read-write; the app only reads these.
    -- occupancy_snapshot is made read-only for the app by db/004 (applied by
    -- scripts/server-upgrade-sync.sh only after the first sync worked and
    -- the old snapshot cron is gone, so a failed upgrade never stops it).
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON his_ward, his_spclty, sync_run, ward_state, ward_spclty_state, daily_census, ward_catalog
      FROM bkh_wait_app;
    GRANT SELECT
      ON his_ward, his_spclty, sync_run, ward_state, ward_spclty_state, daily_census, ward_catalog,
         occupancy_snapshot
      TO bkh_wait_app;
    REVOKE USAGE ON SEQUENCE sync_run_id_seq FROM bkh_wait_app;
  END IF;
END
$$;
