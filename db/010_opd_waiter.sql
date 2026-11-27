-- bkh-wait schema v10: the OPD visits waiting now, per clinic (RESTRICTED,
-- HN). Applied by scripts/db-migrate.mjs (owner account, search_path = wait,
-- one transaction). Never edit after it was applied: add 011_*.sql.
--
-- Same security model as the bed HN (db/006):
--   opd_waiter  RESTRICTED: one row per visit of today that has not seen a
--               doctor yet — exactly the visits the board counts in
--               opd_state.waiting_now (stale = false), plus visits past the
--               board's 8 h limit that were never closed (stale = true, not
--               in the board counts). HN, queue number (ovst.oqueue),
--               times, stage, current department and lab / X-ray flags.
--               No VN, names, CID, address or phone.
--               Written ONLY by the OPD sync worker (scripts/sync-opd.mjs,
--               role bkh_wait_sync, every 5 min 06:00-20:55): replaced as a
--               whole every run in the same transaction as opd_state, so
--               it holds today's waiters only (the last evening run's rows
--               stay until the next morning run; the function below never
--               returns a row of an earlier day). The sync role may INSERT /
--               DELETE but not SELECT it. NOT readable by the web app role.
--   opd_waiters_for_clinic(clinic, actor)
--               the ONLY way the web app reads it: SECURITY DEFINER, returns
--               the waiters of one clinic and appends an audit_log row
--               (actor, 'opd_waiter.view', clinic, row count) in the same
--               statement — no read without an audit row.
-- Definitions: scripts/lib/hosxp-opd.mjs header "Waiters". Backups of this
-- database therefore also contain the HN of today's OPD waiters: protect
-- them like HOSxP backups.

CREATE TABLE opd_waiter (
  visit_date      date NOT NULL,
  clinic_code     text NOT NULL REFERENCES his_opd_clinic (clinic_code) ON DELETE CASCADE,
  hn              text NOT NULL CONSTRAINT opd_waiter_hn_len CHECK (char_length(hn) BETWEEN 1 AND 15),
  -- ovst.oqueue (queue number of the day)
  queue_no        integer,
  -- 'screening' = รอซักประวัติ/คัดกรอง, 'doctor' = รอพบแพทย์ (board waitingForDoctor)
  stage           text NOT NULL CONSTRAINT opd_waiter_stage_valid CHECK (stage IN ('screening', 'doctor')),
  -- registered more than 8 h ago: not in the board counts
  stale           boolean NOT NULL,
  registered_at   timestamptz NOT NULL,
  -- latest OPD-SCREEN begin; NULL = not screened
  screened_at     timestamptz,
  -- minutes at the sync time (HOSxP clock), as the board's longest waits
  minutes_since_registration integer NOT NULL
    CONSTRAINT opd_waiter_reg_minutes_nonneg CHECK (minutes_since_registration >= 0),
  minutes_since_screening    integer
    CONSTRAINT opd_waiter_scr_minutes_nonneg CHECK (minutes_since_screening IS NULL OR minutes_since_screening >= 0),
  -- ovst.cur_dep + kskdepartment name at the sync time
  cur_dep         text,
  cur_dep_name    text CONSTRAINT opd_waiter_dep_name_len CHECK (cur_dep_name IS NULL OR char_length(cur_dep_name) <= 120),
  lab_pending     boolean NOT NULL,
  xray_ordered    boolean NOT NULL,
  sync_run_id     bigint NOT NULL REFERENCES sync_run (id)
);
CREATE INDEX opd_waiter_clinic_idx ON opd_waiter (clinic_code, visit_date);

-- ---------------------------------------------------------------------------
-- The ONLY way the web app reads these HNs. SECURITY DEFINER (runs as the
-- owner), fixed search_path (pg_temp last) and schema-qualified names, as
-- wait.bed_occupants_for_ward (db/006). Returns today's (Asia/Bangkok)
-- waiters of one clinic, longest wait first (since screening, else since
-- registration), and appends ONE audit_log row with the actor, the clinic
-- and the row count. The audit row never contains an HN.
-- ---------------------------------------------------------------------------
CREATE FUNCTION wait.opd_waiters_for_clinic(p_clinic text, p_actor text)
RETURNS TABLE (
  clinic_code                text,
  hn                         text,
  queue_no                   integer,
  stage                      text,
  stale                      boolean,
  registered_at              timestamptz,
  screened_at                timestamptz,
  minutes_since_registration integer,
  minutes_since_screening    integer,
  cur_dep                    text,
  cur_dep_name               text,
  lab_pending                boolean,
  xray_ordered               boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = wait, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_clinic IS NULL OR p_clinic !~ '^[0-9A-Za-z]{1,3}$' THEN
    RAISE EXCEPTION 'invalid clinic' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR char_length(btrim(p_actor)) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid actor' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT w.clinic_code, w.hn, w.queue_no, w.stage, w.stale, w.registered_at, w.screened_at,
           w.minutes_since_registration, w.minutes_since_screening, w.cur_dep, w.cur_dep_name,
           w.lab_pending, w.xray_ordered
      FROM wait.opd_waiter w
     WHERE w.clinic_code = p_clinic
       AND w.visit_date = (now() AT TIME ZONE 'Asia/Bangkok')::date
     ORDER BY w.stale,
              coalesce(w.minutes_since_screening, w.minutes_since_registration) DESC,
              w.queue_no NULLS LAST;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO wait.audit_log (actor, action, entity, entity_id, detail)
  VALUES (btrim(p_actor), 'opd_waiter.view', 'opd_clinic', p_clinic, jsonb_build_object('rows', n));
END;
$$;

-- Functions are executable by PUBLIC by default: only the web app may call it.
REVOKE ALL ON FUNCTION wait.opd_waiters_for_clinic(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Privileges. The default privileges of db/setup.sql granted the app
-- read-write on every new table: take that back.
-- ---------------------------------------------------------------------------
REVOKE ALL ON opd_waiter FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    REVOKE ALL ON opd_waiter FROM bkh_wait_sync;
    -- write-only: the worker replaces the rows but cannot read HNs back
    GRANT INSERT, DELETE ON opd_waiter TO bkh_wait_sync;
  ELSE
    RAISE WARNING 'role bkh_wait_sync does not exist: create it (scripts/db-sync-role.sh), then re-run the GRANTs of db/010_opd_waiter.sql';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE ALL ON opd_waiter FROM bkh_wait_app;
    GRANT EXECUTE ON FUNCTION wait.opd_waiters_for_clinic(text, text) TO bkh_wait_app;
  END IF;
END
$$;
