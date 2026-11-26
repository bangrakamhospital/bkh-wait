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
# Order matters: the web app is switched only after the first sync worked.
#   1. .env.sync: HIS_* moved from .env (or copied from bkh-kpi's .env)
#   2. PostgreSQL role bkh_wait_sync (+ WAIT_SYNC_DATABASE_URL in .env.sync)
#   3. npm ci + migrations (db/003: sync tables, view, grants; the app role
#      becomes read-only on occupancy_snapshot — rows are kept)
#   4. first sync run (abort here leaves the old app serving; only its
#      snapshot cron stops working until this script succeeds)
#   5. cron: snapshot.mjs line replaced by the sync worker
#   6. build, HIS_* / WAIT_SNAPSHOT_TOKEN / WAIT_INTERNAL_URL removed from
#      .env, pm2 restart
#   7. check
set -euo pipefail

APP_DIR=/var/www/wait
KPI_ENV=/var/www/kpi/.env
HIS_RE='^HIS_(HOST|PORT|USER|PASSWORD|DATABASE)='
cd "$APP_DIR"
umask 077

[ -f .env ] || { echo "Missing $APP_DIR/.env - this script upgrades an existing install"; exit 1; }
[ -f scripts/sync-hosxp.mjs ] || { echo "scripts/sync-hosxp.mjs missing - update the checkout first (see header)"; exit 1; }

count_his() { grep -cE "${HIS_RE}.+" "$1" 2>/dev/null || true; }

echo "==> 1/7 .env.sync (HOSxP credentials for the sync worker only)"
[ -f .env.sync ] || : > .env.sync
chmod 600 .env.sync
if [ "$(count_his .env.sync)" = 5 ]; then
  echo "    HIS_* already in .env.sync"
else
  sed -i -E "/${HIS_RE}/d" .env.sync
  if [ "$(count_his .env)" = 5 ]; then SRC=.env; else SRC="$KPI_ENV"; fi
  {
    echo "# HOSxP (read-only) for scripts/sync-hosxp.mjs (moved by scripts/server-upgrade-sync.sh)"
    { grep -E "$HIS_RE" "$SRC" || true; }
  } >> .env.sync
  [ "$(count_his .env.sync)" = 5 ] \
    || { echo "    HIS_* not found in .env or $KPI_ENV - fill them into $APP_DIR/.env.sync and re-run"; exit 1; }
  echo "    HIS_* written to .env.sync (from $SRC)"
fi

echo "==> 2/7 PostgreSQL role bkh_wait_sync"
bash scripts/db-sync-role.sh

echo "==> 3/7 npm packages + migrations"
npm ci --no-audit --no-fund
node --env-file=.env scripts/db-migrate.mjs

echo "==> 4/7 first sync run"
mkdir -p "$APP_DIR/logs"
node --env-file="$APP_DIR/.env.sync" scripts/sync-hosxp.mjs

echo "==> 5/7 cron: snapshot.mjs -> sync-hosxp.mjs"
CRON="*/15 * * * * cd $APP_DIR && /usr/bin/node --env-file=$APP_DIR/.env.sync scripts/sync-hosxp.mjs >> $APP_DIR/logs/sync.log 2>&1"
# `|| true`: crontab -l fails on an empty crontab and grep -v fails when it
# removes every line; neither may abort under set -e / pipefail.
( { crontab -l 2>/dev/null || true; } | { grep -v "/var/www/wait" || true; } ; echo "$CRON" ) | crontab -
crontab -l | { grep "/var/www/wait" || true; } | sed 's/^/    /'

echo "==> 6/7 build + web app without HOSxP credentials"
npm run build
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

echo "==> 7/7 check"
sleep 3
curl -sk https://127.0.0.1:84/api/board | head -c 160; echo
tail -n 2 "$APP_DIR/logs/sync.log" 2>/dev/null || true
echo "Done. Sync log: $APP_DIR/logs/sync.log ; API keys: node scripts/make-api-key.mjs <name>"
