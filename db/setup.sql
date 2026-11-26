-- One-time setup of the bkh-wait database on the deploy server (PostgreSQL 14+).
--
-- Do NOT run this file by hand with passwords on the command line (they
-- would stay in shell history / ps). Use the wrapper, which generates the
-- passwords, feeds them to psql on stdin (psql variables owner_pw / app_pw)
-- and writes WAIT_DATABASE_URL / WAIT_MIGRATE_DATABASE_URL into .env (0600):
--
--   bash scripts/db-setup.sh
--
-- Roles (least privilege):
--   bkh_wait_owner  owns database + schema wait; used ONLY by the migration
--                   script (DDL). Not used by the web app.
--   bkh_wait_app    the web app: CONNECT + SELECT/INSERT/UPDATE/DELETE on the
--                   tables of schema wait, nothing else (no DDL, no other DB).
--                   audit_log additionally refuses UPDATE/DELETE by trigger;
--                   schema_migrations is SELECT-only (db/002 revokes writes);
--                   the HOSxP copies (his_ward, ward_state, daily_census,
--                   sync_run, occupancy_snapshot, ...) are SELECT-only
--                   (db/003 + db/004 revoke writes).
--   bkh_wait_sync   the HOSxP sync worker (scripts/sync-hosxp.mjs): created
--                   by db/sync-role.sql via scripts/db-sync-role.sh (called
--                   by db-setup.sh after this file, before the migrations);
--                   table privileges come from db/003_hosxp_sync.sql.
-- The HOSxP database is NOT touched by anything here, and the web app has no
-- HOSxP credentials: only the sync worker's .env.sync does.

CREATE ROLE bkh_wait_owner LOGIN PASSWORD :'owner_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5;
CREATE ROLE bkh_wait_app LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT CONNECTION LIMIT 20;

CREATE DATABASE bkh_wait OWNER bkh_wait_owner ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE bkh_wait FROM PUBLIC;
GRANT CONNECT ON DATABASE bkh_wait TO bkh_wait_app;

\connect bkh_wait

-- Nobody but the owner creates objects; the app only uses schema wait.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA wait AUTHORIZATION bkh_wait_owner;
GRANT USAGE ON SCHEMA wait TO bkh_wait_app;

-- Tables / sequences the owner creates later (migrations) are usable by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE bkh_wait_owner IN SCHEMA wait
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bkh_wait_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bkh_wait_owner IN SCHEMA wait
  GRANT USAGE, SELECT ON SEQUENCES TO bkh_wait_app;

-- Defaults (the app also sends them at connect time).
ALTER ROLE bkh_wait_owner IN DATABASE bkh_wait SET search_path = wait;
ALTER ROLE bkh_wait_app IN DATABASE bkh_wait SET search_path = wait;
ALTER ROLE bkh_wait_app IN DATABASE bkh_wait SET timezone = 'Asia/Bangkok';
ALTER ROLE bkh_wait_app IN DATABASE bkh_wait SET statement_timeout = '15s';
