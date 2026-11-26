-- Role of the HOSxP sync worker (scripts/sync-hosxp.mjs). Run as the
-- postgres superuser by scripts/db-sync-role.sh (idempotent), which passes
-- the generated password as psql variable sync_pw on STDIN. Not a numbered
-- migration (db-migrate.mjs ignores this file): the owner role may not
-- create roles. Table privileges are granted by db/003_hosxp_sync.sql, so
-- run this BEFORE the migrations (db-setup.sh / server-upgrade-sync.sh do).
--
--   bkh_wait_sync  CONNECT + USAGE on schema wait; SELECT ward_config /
--                  department / ward_catalog; write his_ward, his_spclty,
--                  ward_state, ward_spclty_state, daily_census; INSERT
--                  sync_run, occupancy_snapshot. Nothing else (no refer
--                  requests, no audit log, no DDL).

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkh_wait_sync') AS create_sync_role \gset
\if :create_sync_role
CREATE ROLE bkh_wait_sync LOGIN PASSWORD :'sync_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT CONNECTION LIMIT 3;
\else
ALTER ROLE bkh_wait_sync LOGIN PASSWORD :'sync_pw';
\endif

GRANT CONNECT ON DATABASE bkh_wait TO bkh_wait_sync;
GRANT USAGE ON SCHEMA wait TO bkh_wait_sync;
ALTER ROLE bkh_wait_sync IN DATABASE bkh_wait SET search_path = wait;
ALTER ROLE bkh_wait_sync IN DATABASE bkh_wait SET timezone = 'Asia/Bangkok';
ALTER ROLE bkh_wait_sync IN DATABASE bkh_wait SET statement_timeout = '30s';
