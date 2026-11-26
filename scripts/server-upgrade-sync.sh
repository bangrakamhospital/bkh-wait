#!/usr/bin/env bash
# Upgrade a LIVE bkh-wait install (made by the old server-first-deploy.sh:
# HIS_* in .env, cron -> scripts/snapshot.mjs -> POST /api/snapshot) to the
# PostgreSQL-only design: the web app loses its HOSxP credentials, the
# sync worker scripts/sync-hosxp.mjs (own .env.sync, role bkh_wait_sync)
# reads HOSxP every 15 min. Existing data (occupancy_snapshot, refer-back
# requests, ward config, audit log) is kept.
#
# Run ONCE as bkhadmin in an interactive ssh session (sudo asks for the
# password), after the branch is merged:
#
#   cd /var/www/wait && git fetch -q origin main && git reset -q --hard origin/main
#   bash scripts/server-upgrade-sync.sh
#
# Safe to re-run: every step checks what is already done.
# Order matters — until step 8 the running (old) app keeps working fully,
# including its snapshot cron, so a failure in steps 1-7 changes nothing
# users see; fix the cause and re-run.
#   1. .env.sync: HIS_* copied from .env (or from bkh-kpi's .env)
#   2. PostgreSQL role bkh_wait_sync (+ WAIT_SYNC_DATABASE_URL in .env.sync)
#   3. npm ci
#   4. preflight: the worker reads HOSxP with .env.sync (--dry-run, no writes)
#   5. migrations up to 003 (sync tables, view, grants; additive only)
#   6. first sync run (fills the sync tables)
#   7. build (the running app keeps serving from memory)
#   8. cron: snapshot.mjs line replaced by the sync worker; HIS_* /
#      WAIT_SNAPSHOT_TOKEN / WAIT_INTERNAL_URL removed from .env; pm2 restart
#   9. remaining migrations (004: occupancy_snapshot read-only for the app)
#  10. check
# Never prints passwords or connection strings.
set -Eeuo pipefail

APP_DIR=/var/www/wait
KPI_ENV=/var/www/kpi/.env
HIS_RE='^HIS_(HOST|PORT|USER|PASSWORD|DATABASE)='
cd "$APP_DIR"
umask 077

STEP="start"
on_err() {
  echo
  echo "!! upgrade stopped at step: $STEP"
  case "$STEP" in
    8/*|9/*|10/*) echo "   The new app may be half switched: fix the cause and re-run this script." ;;
    *) echo "   The running app was not switched yet (old app + snapshot cron still work)." \
         "Fix the cause and re-run this script." ;;
  esac
}
trap on_err ERR

[ -f .env ] || { echo "Missing $APP_DIR/.env - this script upgrades an existing install"; exit 1; }
[ -f scripts/sync-hosxp.mjs ] || { echo "scripts/sync-hosxp.mjs missing - update the checkout first (see header)"; exit 1; }
grep -Eq '^WAIT_DATABASE_URL=.+' .env || { echo "WAIT_DATABASE_URL missing in .env - run scripts/db-setup.sh first"; exit 1; }

count_his() { grep -cE "${HIS_RE}.+" "$1" 2>/dev/null || true; }

STEP="1/10 .env.sync"
echo "==> $STEP (HOSxP credentials for the sync worker only)"
[ -f .env.sync ] || : > .env.sync
chmod 600 .env.sync
if [ "$(count_his .env.sync)" = 5 ]; then
  echo "    HIS_* already in .env.sync"
else
  sed -i -E "/${HIS_RE}/d" .env.sync
  if [ "$(count_his .env)" = 5 ]; then SRC=.env; else SRC="$KPI_ENV"; fi
  {
    echo "# HOSxP (read-only) for scripts/sync-hosxp.mjs (copied by scripts/server-upgrade-sync.sh)"
    { grep -E "$HIS_RE" "$SRC" 2>/dev/null || true; }
  } >> .env.sync
  [ "$(count_his .env.sync)" = 5 ] \
    || { echo "    HIS_* not found in .env or $KPI_ENV - fill them into $APP_DIR/.env.sync and re-run"; exit 1; }
  echo "    HIS_* written to .env.sync (from $SRC)"
fi

STEP="2/10 PostgreSQL role bkh_wait_sync"
echo "==> $STEP"
bash scripts/db-sync-role.sh

STEP="3/10 npm packages"
echo "==> $STEP"
npm ci --no-audit --no-fund

STEP="4/10 preflight: HOSxP read with .env.sync"
echo "==> $STEP"
# --dry-run reads HOSxP only (aggregates); output discarded, errors are short codes.
node --env-file="$APP_DIR/.env.sync" scripts/sync-hosxp.mjs --dry-run > /dev/null
echo "    HOSxP ok"

STEP="5/10 migrations up to 003"
echo "==> $STEP"
node --env-file=.env scripts/db-migrate.mjs --to 003

STEP="6/10 first sync run"
echo "==> $STEP"
mkdir -p "$APP_DIR/logs"
node --env-file="$APP_DIR/.env.sync" scripts/sync-hosxp.mjs

STEP="7/10 build"
echo "==> $STEP"
npm run build

STEP="8/10 switch: cron, .env, restart"
echo "==> $STEP"
CRON="*/15 * * * * cd $APP_DIR && /usr/bin/node --env-file=$APP_DIR/.env.sync scripts/sync-hosxp.mjs >> $APP_DIR/logs/sync.log 2>&1"
# `|| true`: crontab -l fails on an empty crontab and grep -v fails when it
# removes every line; neither may abort under set -e / pipefail.
( { crontab -l 2>/dev/null || true; } | { grep -v "/var/www/wait" || true; } ; echo "$CRON" ) | crontab -
crontab -l | { grep "/var/www/wait" || true; } | sed 's/^/    /'
sed -i -E "/${HIS_RE}/d; /^WAIT_SNAPSHOT_TOKEN=/d; /^WAIT_INTERNAL_URL=/d" .env
chmod 600 .env
if grep -qE '^HIS_' .env; then echo "    HIS_* still in .env - remove by hand"; exit 1; fi
grep -q '^WAIT_API_KEYS=' .env || echo "WAIT_API_KEYS=" >> .env
if pm2 describe bkh-wait >/dev/null 2>&1; then
  pm2 restart bkh-wait --update-env
else
  pm2 start npm --name bkh-wait --cwd "$APP_DIR" -- start
fi
pm2 save

STEP="9/10 remaining migrations"
echo "==> $STEP"
node --env-file=.env scripts/db-migrate.mjs

STEP="10/10 check"
echo "==> $STEP"
trap - ERR
for _ in $(seq 1 20); do
  if BODY="$(curl -sk --max-time 5 https://127.0.0.1:84/api/board)" && [ -n "$BODY" ]; then break; fi
  sleep 2
done
printf '    %s\n' "$(printf '%s' "${BODY:-no answer from https://127.0.0.1:84/api/board}" | head -c 160)"
tail -n 2 "$APP_DIR/logs/sync.log" 2>/dev/null || true
echo "Done. Sync log: $APP_DIR/logs/sync.log ; API keys: node scripts/make-api-key.mjs <name>"
