-- bkh-wait schema v6: physical beds per ward (public) and the patient on
-- each bed (RESTRICTED). Applied by scripts/db-migrate.mjs (owner account,
-- search_path = wait, one transaction). Never edit after it was applied.
--
-- Written ONLY by the bed sync worker (scripts/sync-hosxp.mjs, role
-- bkh_wait_sync), both tables replaced as a whole every run in the same
-- transaction as ward_state. Definitions: scripts/lib/hosxp.mjs.
--
--   bed_slot      public, non-identifying: bed number / name / room and an
--                 occupied flag. The web app reads it (board bedSlots).
--   bed_occupant  RESTRICTED: HN, admit date and spclty per occupied bed.
--                 NOT readable by the web app role or anyone else except
--                 the owner. The web app reads it ONLY through
--                 wait.bed_occupants_for_ward(), which writes an audit_log
--                 row (actor, 'view_hn', ward, row count) in the same
--                 statement — no read without an audit row. The sync role
--                 may INSERT / DELETE but not SELECT it.
-- HN is the only identifier kept (no AN, name, CID). Backups of this
-- database therefore contain current inpatient HNs: protect them like
-- HOSxP backups.

-- ---------------------------------------------------------------------------
-- Physical beds of the non-virtual wards (bedno is unique in HOSxP).
-- ---------------------------------------------------------------------------
CREATE TABLE bed_slot (
  bedno       text PRIMARY KEY
    CONSTRAINT bed_slot_bedno_len CHECK (char_length(bedno) BETWEEN 1 AND 20),
  ward_code   text NOT NULL REFERENCES his_ward (ward_code) ON DELETE CASCADE,
  bed_name    text NOT NULL CONSTRAINT bed_slot_name_len CHECK (char_length(bed_name) BETWEEN 1 AND 80),
  room_no     text,
  room_name   text,
  -- HOSxP order within the ward (roomno, bed_order, bedno)
  sort_order  integer NOT NULL,
  occupied    boolean NOT NULL,
  sync_run_id bigint NOT NULL REFERENCES sync_run (id)
);
CREATE INDEX bed_slot_ward_idx ON bed_slot (ward_code, sort_order);

-- ---------------------------------------------------------------------------
-- RESTRICTED: current inpatient on a bed (one row per bed and HN).
-- ---------------------------------------------------------------------------
CREATE TABLE bed_occupant (
  bedno       text NOT NULL REFERENCES bed_slot (bedno) ON DELETE CASCADE,
  ward_code   text NOT NULL,
  hn          text NOT NULL CONSTRAINT bed_occupant_hn_len CHECK (char_length(hn) BETWEEN 1 AND 15),
  admit_date  date NOT NULL,
  spclty_code text,
  sync_run_id bigint NOT NULL REFERENCES sync_run (id),
  PRIMARY KEY (bedno, hn)
);
CREATE INDEX bed_occupant_ward_idx ON bed_occupant (ward_code);

-- ---------------------------------------------------------------------------
-- The ONLY way the web app reads HNs. SECURITY DEFINER (runs as the owner,
-- who owns bed_occupant and audit_log), fixed search_path (pg_temp last) and
-- schema-qualified names, so a caller cannot redirect it to its own objects.
-- Returns the occupants of one ward and appends ONE audit_log row with the
-- actor (session username), the ward and the number of rows returned. The
-- audit insert is part of the same statement: if it fails, nothing is
-- returned.
-- ---------------------------------------------------------------------------
CREATE FUNCTION wait.bed_occupants_for_ward(p_ward text, p_actor text)
RETURNS TABLE (
  bedno               text,
  bed_name            text,
  room_name           text,
  hn                  text,
  admit_date          date,
  length_of_stay_days integer,
  spclty_code         text,
  spclty_name         text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = wait, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_ward IS NULL OR p_ward !~ '^[0-9A-Za-z]{1,4}$' THEN
    RAISE EXCEPTION 'invalid ward' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR char_length(btrim(p_actor)) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid actor' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT o.bedno, s.bed_name, s.room_name, o.hn, o.admit_date,
           GREATEST((now() AT TIME ZONE 'Asia/Bangkok')::date - o.admit_date, 0)::integer,
           o.spclty_code,
           coalesce(nullif(btrim(sp.name), ''), 'ไม่ระบุ')
      FROM wait.bed_occupant o
      JOIN wait.bed_slot s ON s.bedno = o.bedno
      LEFT JOIN wait.his_spclty sp ON sp.spclty_code = o.spclty_code
     WHERE o.ward_code = p_ward
     ORDER BY s.sort_order, o.hn;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO wait.audit_log (actor, action, entity, entity_id, detail)
  VALUES (btrim(p_actor), 'view_hn', 'ward', p_ward, jsonb_build_object('rows', n));
END;
$$;

-- Functions are executable by PUBLIC by default: only the web app may call it.
REVOKE ALL ON FUNCTION wait.bed_occupants_for_ward(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Privileges. The default privileges of db/setup.sql granted the app
-- read-write on every new table: take that back.
-- ---------------------------------------------------------------------------
REVOKE ALL ON bed_occupant FROM PUBLIC;
REVOKE ALL ON bed_slot FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    GRANT SELECT, INSERT, DELETE ON bed_slot TO bkh_wait_sync;
    -- write-only: the worker replaces the rows but cannot read HNs back
    GRANT INSERT, DELETE ON bed_occupant TO bkh_wait_sync;
  ELSE
    RAISE WARNING 'role bkh_wait_sync does not exist: create it (scripts/db-sync-role.sh), then re-run the GRANTs of db/006_bed_occupant.sql';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE ALL ON bed_occupant FROM bkh_wait_app;
    REVOKE ALL ON bed_slot FROM bkh_wait_app;
    GRANT SELECT ON bed_slot TO bkh_wait_app;
    GRANT EXECUTE ON FUNCTION wait.bed_occupants_for_ward(text, text) TO bkh_wait_app;
  END IF;
END
$$;
