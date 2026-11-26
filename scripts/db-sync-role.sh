#!/usr/bin/env bash
# Create (or re-key) the PostgreSQL role bkh_wait_sync of the HOSxP sync
# worker and write WAIT_SYNC_DATABASE_URL into .env.sync (mode 0600).
# Run ON THE SERVER as the app user, from the app dir, BEFORE the
# migrations (db/003 grants the table privileges to this role):
#
#   cd /var/www/wait && bash scripts/db-sync-role.sh
#
# Idempotent: does nothing when .env.sync already has WAIT_SYNC_DATABASE_URL.
# Otherwise creates the role (or sets a new password if the role exists).
# The password is generated here, passed to psql on STDIN, never printed.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYNC_ENV="$APP_DIR/.env.sync"
cd "$APP_DIR"
umask 077

[ -f "$SYNC_ENV" ] || : > "$SYNC_ENV"
chmod 600 "$SYNC_ENV"
if grep -Eq '^WAIT_SYNC_DATABASE_URL=.+' "$SYNC_ENV"; then
  echo "    WAIT_SYNC_DATABASE_URL already set in .env.sync - role kept as is"
  exit 0
fi
command -v psql >/dev/null || { echo "PostgreSQL client (psql) not found"; exit 1; }

SYNC_PW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
{
  printf '\set ON_ERROR_STOP on\n'
  printf "\\set sync_pw '%s'\n" "$SYNC_PW"
  cat db/sync-role.sql
} | sudo -u postgres psql -q -X -d bkh_wait

sed -i -E '/^WAIT_SYNC_DATABASE_URL=$/d' "$SYNC_ENV"
{
  echo "# PostgreSQL role of the sync worker (written by scripts/db-sync-role.sh)"
  echo "WAIT_SYNC_DATABASE_URL=postgres://bkh_wait_sync:${SYNC_PW}@127.0.0.1:5432/bkh_wait"
} >> "$SYNC_ENV"
unset SYNC_PW
echo "    role bkh_wait_sync ready, WAIT_SYNC_DATABASE_URL written to .env.sync"
