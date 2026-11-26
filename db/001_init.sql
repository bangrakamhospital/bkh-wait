-- bkh-wait schema v1 (PostgreSQL 14+, database bkh_wait, schema wait).
-- Applied by scripts/db-migrate.mjs inside one transaction with
-- search_path = wait. Never edit after it was applied: add 002_*.sql.
--
-- Nothing here holds patient identifiers: occupancy is aggregate counts,
-- refer-back requests carry a free-text case reference from the sending
-- hospital (the API rejects 13-digit numbers that look like a national ID).

-- ---------------------------------------------------------------------------
-- Bed departments ("แผนก"): groups of wards shown together on the board.
-- ---------------------------------------------------------------------------
CREATE TABLE department (
  department_code text PRIMARY KEY
    CONSTRAINT department_code_format CHECK (department_code ~ '^[a-z0-9][a-z0-9_-]{0,19}$'),
  name            text NOT NULL
    CONSTRAINT department_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  sort_order      integer NOT NULL DEFAULT 0,
  updated_by      text NOT NULL DEFAULT 'system',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Per-ward overrides on top of HOSxP `ward` (active wards come from HOSxP;
-- a ward without a row here uses HOSxP name / bedcount and is visible).
-- ---------------------------------------------------------------------------
CREATE TABLE ward_config (
  ward_code       text PRIMARY KEY
    CONSTRAINT ward_config_code_format CHECK (ward_code ~ '^[0-9A-Za-z]{1,4}$'),
  display_name    text
    CONSTRAINT ward_config_name_len CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 80),
  bed_capacity    integer
    CONSTRAINT ward_config_beds_range CHECK (bed_capacity IS NULL OR bed_capacity BETWEEN 0 AND 999),
  visible         boolean NOT NULL DEFAULT true,
  -- Virtual ward (e.g. Home Ward): patients share a placeholder bed, so the
  -- ward is left off the board, snapshots and refer-back targets.
  is_virtual      boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 0,
  department_code text REFERENCES department (department_code) ON UPDATE CASCADE ON DELETE SET NULL,
  updated_by      text NOT NULL DEFAULT 'system',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ward_config_department_idx ON ward_config (department_code);

-- ---------------------------------------------------------------------------
-- Occupancy history: one row per ward every 15 minutes (cron -> POST
-- /api/snapshot). ~280k rows/year for 8 wards; no retention needed yet.
-- ---------------------------------------------------------------------------
CREATE TABLE occupancy_snapshot (
  taken_at  timestamptz NOT NULL,
  ward_code text NOT NULL,
  occupied  integer NOT NULL CONSTRAINT occupancy_snapshot_occupied_nonneg CHECK (occupied >= 0),
  beds      integer NOT NULL CONSTRAINT occupancy_snapshot_beds_nonneg CHECK (beds >= 0),
  PRIMARY KEY (taken_at, ward_code)
);
CREATE INDEX occupancy_snapshot_ward_idx ON occupancy_snapshot (ward_code, taken_at);

-- ---------------------------------------------------------------------------
-- Refer-back requests (regional hospital -> Bangrakam).
-- waiting -> accepted -> admitted ; waiting|accepted -> cancelled
-- ---------------------------------------------------------------------------
CREATE TABLE refer_back_request (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_ref       text NOT NULL
    CONSTRAINT refer_case_ref_len CHECK (char_length(btrim(case_ref)) BETWEEN 1 AND 60),
  from_hospital  text NOT NULL
    CONSTRAINT refer_from_hospital_len CHECK (char_length(btrim(from_hospital)) BETWEEN 1 AND 120),
  ward_code      text
    CONSTRAINT refer_ward_code_format CHECK (ward_code IS NULL OR ward_code ~ '^[0-9A-Za-z]{1,4}$'),
  diagnosis_note text NOT NULL DEFAULT ''
    CONSTRAINT refer_diagnosis_note_len CHECK (char_length(diagnosis_note) <= 500),
  status         text NOT NULL DEFAULT 'waiting'
    CONSTRAINT refer_status_valid CHECK (status IN ('waiting', 'accepted', 'admitted', 'cancelled')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at    timestamptz,
  admitted_at    timestamptz,
  cancelled_at   timestamptz,
  created_by     text NOT NULL,
  updated_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Timestamps must agree with the status.
  CONSTRAINT refer_status_timestamps CHECK (
    (status = 'waiting'   AND accepted_at IS NULL AND admitted_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'accepted'  AND accepted_at IS NOT NULL AND admitted_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'admitted'  AND accepted_at IS NOT NULL AND admitted_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND admitted_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
CREATE INDEX refer_status_ward_idx ON refer_back_request (status, ward_code);
CREATE INDEX refer_requested_at_idx ON refer_back_request (requested_at DESC);

-- ---------------------------------------------------------------------------
-- Audit log (append-only: UPDATE / DELETE refused by trigger).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, at);
CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Default grouping. Derived from the dominant HOSxP ipt.spclty of each
-- active ward over the last 365 days (checked 2026-11-26):
--   01, 02 -> อายุรกรรม   03 -> กุมารเวชกรรม   04 -> สูติกรรม
--   16 -> จักษุ   19 -> จิตเวช   18 -> แพทย์แผนไทย
-- Ward 17 is a Home Ward (confirmed by the hospital): every current patient
-- shares placeholder bed HW01, so it is virtual and never shown.
-- Staff can change it later with PUT /api/departments.
-- ---------------------------------------------------------------------------
INSERT INTO department (department_code, name, sort_order) VALUES
  ('med', 'อายุรกรรม', 10),
  ('ped', 'กุมารเวชกรรม', 20),
  ('obs', 'สูติกรรม', 30),
  ('eye', 'จักษุ', 40),
  ('psy', 'จิตเวช', 50),
  ('ttm', 'แพทย์แผนไทย', 60);

INSERT INTO ward_config (ward_code, sort_order, department_code, is_virtual) VALUES
  ('01', 10, 'med', false),
  ('02', 20, 'med', false),
  ('03', 30, 'ped', false),
  ('04', 40, 'obs', false),
  ('16', 50, 'eye', false),
  ('19', 60, 'psy', false),
  ('18', 70, 'ttm', false),
  ('17', 90, NULL, true);
