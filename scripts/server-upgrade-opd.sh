#!/usr/bin/env bash
# Upgrade a LIVE bkh-wait install (already on the PostgreSQL-only design:
# .env.sync + cron scripts/sync-hosxp.mjs) to the version with the OPD
# "waiting to see a doctor" board (/opd, scripts/sync-opd.mjs, db/005).
#
# Run as bkhadmin (no sudo needed), after the branch is merged to main:
#
#   cd /var/www/wait && bash scripts/server-upgrade-opd.sh
#
# Steps (each one checked; safe to re-run):
#   1. git fetch + reset --hard origin/main, then re-run the NEW copy of
#      this script (--no-fetch)
#   2. npm ci
#   3. preflight: the OPD worker reads HOSxP with .env.sync (--dry-run, no writes)
#   4. migrations (005: OPD tables, sync_run.job, grants; additive only)
#   5. build
#   6. pm2 restart (the new app reads bed freshness from job = 'beds' runs)
#   7. first OPD sync, backfilling the last 30 days into opd_daily
#   8. cron: add the OPD line (every 5 min 06:00-20:55) if it is missing;
#      the bed sync line is left as it is
#   9. check GET /api/opd/board
# No `set -e` / pipefail: crontab -l on an empty crontab and grep without a
# match return non-zero; every step checks its own result instead.
# Never prints passwords or connection strings.

APP_DIR=/var/www/wait
LOG_DIR="$APP_DIR/logs"
OPD_CRON="*/5 6-20 * * * cd $APP_DIR && /usr/bin/node --env-file=$APP_DIR/.env.sync scripts/sync-opd.mjs >> $LOG_DIR/sync-opd.log 2>&1"

fail() {
  echo
  echo "!! upgrade stopped at step: $1"
  echo "   Fix the cause and re-run: bash scripts/server-upgrade-opd.sh"
  exit 1
}

# Everything lives in main(): bash has parsed the whole file before step 1
# rewrites it with git reset.
main() {
  cd "$APP_DIR" || fail "cd $APP_DIR"
  umask 077

  if [ "${1:-}" != "--no-fetch" ]; then
    echo "==> 1/9 update checkout (origin/main)"
    git fetch -q origin main || fail "1/9 git fetch"
    git reset -q --hard origin/main || fail "1/9 git reset"
    git log -1 --format='    %h %s'
    [ -f scripts/server-upgrade-opd.sh ] || fail "1/9 scripts/server-upgrade-opd.sh missing on origin/main"
    exec bash scripts/server-upgrade-opd.sh --no-fetch
  fi

  [ -f .env ] || fail "check: $APP_DIR/.env missing (not an existing install)"
  [ -f .env.sync ] || fail "check: $APP_DIR/.env.sync missing - run scripts/server-upgrade-sync.sh first"
  [ "$(grep -cE '^HIS_(HOST|PORT|USER|PASSWORD|DATABASE)=.+' .env.sync)" = 5 ] \
    || fail "check: HIS_* incomplete in .env.sync"
  grep -qE '^WAIT_SYNC_DATABASE_URL=.+' .env.sync || fail "check: WAIT_SYNC_DATABASE_URL missing in .env.sync"
  [ -f scripts/sync-opd.mjs ] || fail "check: scripts/sync-opd.mjs missing - is the OPD branch merged?"
  mkdir -p "$LOG_DIR" || fail "check: mkdir $LOG_DIR"

  echo "==> 2/9 npm packages"
  npm ci --no-audit --no-fund || fail "2/9 npm ci"

  echo "==> 3/9 preflight: HOSxP read with .env.sync"
  node --env-file="$APP_DIR/.env.sync" scripts/sync-opd.mjs --dry-run > /dev/null || fail "3/9 OPD dry run"
  echo "    HOSxP ok"

  echo "==> 4/9 migrations"
  npm run -s db:migrate || fail "4/9 migrations"

  echo "==> 5/9 build"
  npm run build || fail "5/9 build"

  echo "==> 6/9 restart"
  if pm2 describe bkh-wait > /dev/null 2>&1; then
    pm2 restart bkh-wait --update-env || fail "6/9 pm2 restart"
  else
    pm2 start npm --name bkh-wait --cwd "$APP_DIR" -- start || fail "6/9 pm2 start"
  fi
  pm2 save > /dev/null 2>&1

  echo "==> 7/9 first OPD sync (+ last 30 days)"
  node --env-file="$APP_DIR/.env.sync" scripts/sync-opd.mjs --backfill=30 >> "$LOG_DIR/sync-opd.log" 2>&1 \
    || { tail -n 1 "$LOG_DIR/sync-opd.log"; fail "7/9 first OPD sync"; }
  tail -n 1 "$LOG_DIR/sync-opd.log" | sed 's/^/    /'

  echo "==> 8/9 cron"
  CURRENT="$(crontab -l 2>/dev/null)"
  if printf '%s\n' "$CURRENT" | grep -q 'scripts/sync-opd.mjs'; then
    echo "    OPD cron line already present"
  else
    if [ -n "$CURRENT" ]; then
      printf '%s\n%s\n' "$CURRENT" "$OPD_CRON" | crontab - || fail "8/9 crontab"
    else
      printf '%s\n' "$OPD_CRON" | crontab - || fail "8/9 crontab"
    fi
    echo "    OPD cron line added"
  fi
  crontab -l 2>/dev/null | grep "$APP_DIR" | sed 's/^/    /'

  echo "==> 9/9 check"
  BODY=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    BODY="$(curl -sk --max-time 5 https://127.0.0.1:84/api/opd/board 2>/dev/null)"
    [ -n "$BODY" ] && break
    sleep 2
  done
  printf '    %s\n' "$(printf '%s' "${BODY:-no answer from https://127.0.0.1:84/api/opd/board}" | head -c 200)"
  echo "Done. OPD board: https://10.10.10.159:84/opd ; log: $LOG_DIR/sync-opd.log"
}

main "$@"
