#!/usr/bin/env bash
# One-time creation of the bkh-wait PostgreSQL database (bkh_wait) on the
# server. Run ON THE SERVER as the app user (bkhadmin), from the app dir:
#
#   cd /var/www/wait && bash scripts/db-setup.sh
#
# What it does
#   1. generates two random passwords (kept only in shell variables)
#   2. runs db/setup.sql as the postgres superuser, passing the passwords
#      on psql's STDIN (never on a command line: not visible in ps / history)
#   3. appends WAIT_DATABASE_URL (app account) and WAIT_MIGRATE_DATABASE_URL
#      (owner account) to .env (mode 0600) — refuses if they already exist
#   4. creates the sync worker role bkh_wait_sync and writes
#      WAIT_SYNC_DATABASE_URL to .env.sync (scripts/db-sync-role.sh)
#   5. runs the migrations (scripts/db-migrate.mjs; db/003 grants the
#      sync tables to bkh_wait_sync / bkh_wait_app)
# Passwords are never printed. Afterwards: pm2 restart bkh-wait --update-env
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
cd "$APP_DIR"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy .env.example first)"; exit 1; }
if grep -Eq '^WAIT_(MIGRATE_)?DATABASE_URL=.+' "$ENV_FILE"; then
  echo "WAIT_DATABASE_URL is already set in $ENV_FILE - nothing to do."
  echo "(To start over: drop the database/roles by hand and remove the WAIT_*DATABASE_URL lines.)"
  exit 1
fi
command -v psql >/dev/null || { echo "PostgreSQL client (psql) not found: sudo apt install postgresql"; exit 1; }
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname IN ('bkh_wait_owner','bkh_wait_app')" | grep -q 1; then
  echo "Roles bkh_wait_owner / bkh_wait_app already exist - refusing to change them."
  exit 1
fi

gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40; }
OWNER_PW="$(gen)"
APP_PW="$(gen)"

echo "==> creating roles + database bkh_wait"
{
  printf '\\set ON_ERROR_STOP on\n'
  printf "\\\\set owner_pw '%s'\n" "$OWNER_PW"
  printf "\\\\set app_pw '%s'\n" "$APP_PW"
  cat db/setup.sql
} | sudo -u postgres psql -q -X -d postgres

echo "==> writing WAIT_*DATABASE_URL to $ENV_FILE"
umask 077
# drop the empty template lines (from .env.example) so the new values are the only ones
sed -i -E '/^WAIT_(MIGRATE_)?DATABASE_URL=$/d' "$ENV_FILE"
{
  echo ""
  echo "# bkh-wait database (written by scripts/db-setup.sh)"
  echo "WAIT_DATABASE_URL=postgres://bkh_wait_app:${APP_PW}@127.0.0.1:5432/bkh_wait"
  echo "WAIT_MIGRATE_DATABASE_URL=postgres://bkh_wait_owner:${OWNER_PW}@127.0.0.1:5432/bkh_wait"
} >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
unset OWNER_PW APP_PW

echo "==> sync worker role (bkh_wait_sync -> .env.sync)"
bash scripts/db-sync-role.sh

echo "==> migrations"
node --env-file="$ENV_FILE" scripts/db-migrate.mjs

echo "==> done. Restart the app: pm2 restart bkh-wait --update-env"
