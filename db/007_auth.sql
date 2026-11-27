-- bkh-wait schema v7: sign-in like bkh-kpi. Applied by scripts/db-migrate.mjs
-- (owner account, search_path = wait, one transaction). Never edit after it
-- was applied: add 008_*.sql.
--
--   app_user     Provider ID (PLK Health ID / MOPH Provider ID) accounts,
--                upserted on every SSO sign-in that passes the org
--                allow-list. New accounts are 'pending' until an admin
--                approves them at /admin/users. No citizen ID / email.
--   access_code  per-person codes for outsiders, issued by an admin at
--                /admin/access-codes. Only an HMAC-SHA256 of the code is
--                stored (key from env, never in the database). Revoking
--                keeps the row (audit trail); the app role cannot DELETE.
--
-- Logins and admin actions are written to the existing append-only
-- audit_log (actions 'auth.*', 'user.*', 'access_code.*').
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- OIDC `sub` of Provider ID (stable identity)
  sub           text NOT NULL UNIQUE
    CONSTRAINT app_user_sub_len CHECK (char_length(sub) BETWEEN 1 AND 256),
  -- prename + fname + lname
  name          text NOT NULL DEFAULT ''
    CONSTRAINT app_user_name_len CHECK (char_length(name) <= 200),
  org_code      text NOT NULL DEFAULT ''
    CONSTRAINT app_user_org_code_len CHECK (char_length(org_code) <= 32),
  org_name      text NOT NULL DEFAULT ''
    CONSTRAINT app_user_org_name_len CHECK (char_length(org_name) <= 200),
  job_position  text NOT NULL DEFAULT ''
    CONSTRAINT app_user_job_position_len CHECK (char_length(job_position) <= 200),
  status        text NOT NULL DEFAULT 'pending'
    CONSTRAINT app_user_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
  role          text NOT NULL DEFAULT 'staff'
    CONSTRAINT app_user_role_valid CHECK (role IN ('admin', 'staff')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  -- SSO sign-in attempts (also counted while pending / rejected)
  login_count   integer NOT NULL DEFAULT 0
    CONSTRAINT app_user_login_count_nonneg CHECK (login_count >= 0),
  -- who approved / rejected / changed the role last (principal id + name)
  decided_by      text,
  decided_by_name text,
  decided_at      timestamptz
);

CREATE INDEX app_user_status_idx ON app_user (status, last_login_at DESC);

CREATE TABLE access_code (
  -- 'ac-' + 12 base64url characters (72 random bits); not secret
  id              text PRIMARY KEY
    CONSTRAINT access_code_id_format CHECK (id ~ '^ac-[A-Za-z0-9_-]{12}$'),
  name            text NOT NULL
    CONSTRAINT access_code_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  org             text NOT NULL
    CONSTRAINT access_code_org_len CHECK (char_length(btrim(org)) BETWEEN 1 AND 120),
  -- HMAC-SHA256 (hex) of the normalised code; never the code itself
  code_hash       text NOT NULL UNIQUE
    CONSTRAINT access_code_hash_format CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  created_by_name text NOT NULL,
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz,
  use_count       integer NOT NULL DEFAULT 0
    CONSTRAINT access_code_use_count_nonneg CHECK (use_count >= 0),
  revoked_at      timestamptz,
  revoked_by      text,
  revoked_by_name text,
  CONSTRAINT access_code_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT access_code_revoked_consistent CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX access_code_created_idx ON access_code (created_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges. db/setup.sql's default privileges granted the app SELECT,
-- INSERT, UPDATE, DELETE on these tables: rows are never deleted (revoking
-- a code / rejecting a user keeps the record), so take DELETE back.
-- ---------------------------------------------------------------------------
REVOKE ALL ON app_user FROM PUBLIC;
REVOKE ALL ON access_code FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_app') THEN
    REVOKE ALL ON app_user, access_code FROM bkh_wait_app;
    GRANT SELECT, INSERT, UPDATE ON app_user, access_code TO bkh_wait_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') THEN
    REVOKE ALL ON app_user, access_code FROM bkh_wait_sync;
  END IF;
END
$$;
