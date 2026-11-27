#!/usr/bin/env bash
# Upgrade a LIVE bkh-wait install (already on the PostgreSQL-only design:
# .env.sync + cron scripts/sync-hosxp.mjs) to origin/main. The one script
# for every later deploy: applies whatever migrations are pending (e.g.
# 005 OPD, 006 bed slots / restricted bed occupants) and makes sure both
# cron lines exist.
#
# Run as bkhadmin (no sudo needed), after the branch is merged to main:
#
#   cd /var/www/wait && bash scripts/server-upgrade.sh
#
# Steps (each one checked; safe to re-run):
#    1. git fetch + reset --hard origin/main, then re-run the NEW copy of
#       this script (--no-fetch)
#    -  auth settings in .env (idempotent, values never printed): copy
#       AUTH_PLKHEALTH_ISSUER / ID / SECRET / ALLOWED_ORGS and AUTH_ADMIN_SUBS
#       from /var/www/kpi/.env when missing, set AUTH_PLKHEALTH_REDIRECT_URI=
#       https://10.10.10.159:84/auth/callback when missing, generate
#       AUTH_SECRET and WAIT_ACCESS_CODE_SECRET when missing; create a backup
#       "admin" login in WAIT_USERS when none exists (password printed once)
#    2. npm ci
#    3. preflight: both workers read HOSxP with .env.sync (--dry-run, no writes)
#    4. migrations (npm run db:migrate; no-op when up to date)
#    5. one bed sync now (fills bed_slot / bed_occupant without waiting 15 min)
#    6. build
#    7. pm2 restart
#    8. OPD: first install (no OPD cron line yet) -> first sync with 30 days
#       backfill
#    9. cron: add the bed line (every 15 min) and the OPD line (every 5 min
#       06:00-20:55) if missing; existing lines are left as they are
#   10. check GET /api/board (bedSlots present) and that
#       GET /api/beds/occupants answers 401 without a login
# No `set -e` / pipefail: crontab -l on an empty crontab and grep without a
# match return non-zero; every step checks its own result instead.
# Never prints passwords, connection strings or patient data (the workers
# print counts only).

APP_DIR=/var/www/wait
LOG_DIR="$APP_DIR/logs"
BED_CRON="*/15 * * * * cd $APP_DIR && /usr/bin/node --env-file=$APP_DIR/.env.sync scripts/sync-hosxp.mjs >> $LOG_DIR/sync.log 2>&1"
OPD_CRON="*/5 6-20 * * * cd $APP_DIR && /usr/bin/node --env-file=$APP_DIR/.env.sync scripts/sync-opd.mjs >> $LOG_DIR/sync-opd.log 2>&1"

fail() {
  echo
  echo "!! upgrade stopped at step: $1"
  echo "   Fix the cause and re-run: bash scripts/server-upgrade.sh"
  exit 1
}

# Adds $2 to the crontab unless a line containing $1 is already there.
ensure_cron() {
  local marker="$1" line="$2" current
  current="$(crontab -l 2>/dev/null)"
  if printf '%s\n' "$current" | grep -qF "$marker"; then
    echo "    cron: $marker already present"
    return 0
  fi
  if [ -n "$current" ]; then
    printf '%s\n%s\n' "$current" "$line" | crontab - || return 1
  else
    printf '%s\n' "$line" | crontab - || return 1
  fi
  echo "    cron: $marker added"
}

# --- auth settings in .env (Provider ID SSO, access codes) -------------------
# Idempotent: only keys that are missing or empty are written; existing
# values are never changed. Values are never printed.
KPI_ENV=/var/www/kpi/.env
WAIT_REDIRECT_URI=https://10.10.10.159:84/auth/callback

env_has() { grep -qE "^$1=.+" .env; }

# Appends KEY=VALUE (dropping an empty "KEY=" line first).
env_put() {
  sed -i "/^$1=[[:space:]]*\$/d" .env || return 1
  printf '%s=%s\n' "$1" "$2" >> .env || return 1
  echo "    .env: $1 added"
}

# Raw value of KEY in bkh-kpi's .env (last occurrence), empty if none.
kpi_value() {
  [ -r "$KPI_ENV" ] || return 0
  grep -E "^$1=" "$KPI_ENV" | tail -n 1 | cut -d= -f2-
}

copy_from_kpi() {
  local key="$1" value
  if env_has "$key"; then echo "    .env: $key already set"; return 0; fi
  value="$(kpi_value "$key")"
  if [ -z "$value" ]; then
    echo "    .env: $key missing here and in $KPI_ENV - set it by hand if needed"
    return 0
  fi
  env_put "$key" "$value"
}

new_secret() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }

ensure_auth_env() {
  [ -r "$KPI_ENV" ] || echo "    note: $KPI_ENV not readable - Provider ID settings cannot be copied"
  copy_from_kpi AUTH_PLKHEALTH_ISSUER || return 1
  copy_from_kpi AUTH_PLKHEALTH_ID || return 1
  copy_from_kpi AUTH_PLKHEALTH_SECRET || return 1
  copy_from_kpi AUTH_PLKHEALTH_ALLOWED_ORGS || return 1
  copy_from_kpi AUTH_ADMIN_SUBS || return 1
  if env_has AUTH_PLKHEALTH_REDIRECT_URI; then
    echo "    .env: AUTH_PLKHEALTH_REDIRECT_URI already set"
  else
    env_put AUTH_PLKHEALTH_REDIRECT_URI "$WAIT_REDIRECT_URI" || return 1
  fi
  # bkh-wait's own secrets: never shared with bkh-kpi.
  local key value
  for key in AUTH_SECRET WAIT_ACCESS_CODE_SECRET; do
    if env_has "$key"; then echo "    .env: $key already set"; continue; fi
    value="$(new_secret)" || return 1
    [ "${#value}" -ge 32 ] || return 1
    env_put "$key" "$value" || return 1
  done
  # Backup admin account (approves Provider ID users, issues access codes)
  # so the admin pages are usable before Provider ID works on :84.
  # Created once; the password is printed ONCE.
  if ! grep -E "^WAIT_USERS=" .env | tail -n 1 | grep -qE "(=|,)[^:,]+:admin:"; then
    local pw entry current
    pw="$(new_secret | tr -dc "A-Za-z0-9" | head -c 14)"
    [ "${#pw}" -ge 12 ] || return 1
    entry="$(printf "%s" "$pw" | node scripts/hash-password.mjs admin admin)" || return 1
    case "$entry" in admin:admin:scrypt*) ;; *) return 1 ;; esac
    current="$(grep -E "^WAIT_USERS=" .env | tail -n 1 | cut -d= -f2-)"
    sed -i "/^WAIT_USERS=/d" .env || return 1
    printf "WAIT_USERS=%s\n" "${current:+$current,}$entry" >> .env || return 1
    echo
    echo "    *** backup admin login (shown once, write it down) ***"
    echo "    username: admin"
    echo "    password: $pw"
    echo
    unset pw entry
  fi
  chmod 600 .env || return 1
}

# Everything lives in main(): bash has parsed the whole file before step 1
# rewrites it with git reset.
main() {
  cd "$APP_DIR" || fail "cd $APP_DIR"
  umask 077

  if [ "${1:-}" != "--no-fetch" ]; then
    echo "==> 1/10 update checkout (origin/main)"
    git fetch -q origin main || fail "1/10 git fetch"
    git reset -q --hard origin/main || fail "1/10 git reset"
    git log -1 --format='    %h %s'
    [ -f scripts/server-upgrade.sh ] || fail "1/10 scripts/server-upgrade.sh missing on origin/main"
    exec bash scripts/server-upgrade.sh --no-fetch
  fi

  [ -f .env ] || fail "check: $APP_DIR/.env missing (not an existing install)"
  [ -f .env.sync ] || fail "check: $APP_DIR/.env.sync missing - run scripts/server-upgrade-sync.sh first"
  [ "$(grep -cE '^HIS_(HOST|PORT|USER|PASSWORD|DATABASE)=.+' .env.sync)" = 5 ] \
    || fail "check: HIS_* incomplete in .env.sync"
  grep -qE '^WAIT_SYNC_DATABASE_URL=.+' .env.sync || fail "check: WAIT_SYNC_DATABASE_URL missing in .env.sync"
  mkdir -p "$LOG_DIR" || fail "check: mkdir $LOG_DIR"

  echo "==> auth settings (.env)"
  ensure_auth_env || fail "auth settings in .env"

  echo "==> 2/10 npm packages"
  npm ci --no-audit --no-fund || fail "2/10 npm ci"

  echo "==> 3/10 preflight: HOSxP read with .env.sync"
  node --env-file="$APP_DIR/.env.sync" scripts/sync-hosxp.mjs --dry-run > /dev/null || fail "3/10 bed dry run"
  if [ -f scripts/sync-opd.mjs ]; then
    node --env-file="$APP_DIR/.env.sync" scripts/sync-opd.mjs --dry-run > /dev/null || fail "3/10 OPD dry run"
  fi
  echo "    HOSxP ok"

  echo "==> 4/10 migrations"
  npm run -s db:migrate || fail "4/10 migrations"

  echo "==> 5/10 bed sync"
  node --env-file="$APP_DIR/.env.sync" scripts/sync-hosxp.mjs >> "$LOG_DIR/sync.log" 2>&1 \
    || { tail -n 1 "$LOG_DIR/sync.log"; fail "5/10 bed sync"; }
  tail -n 1 "$LOG_DIR/sync.log" | sed 's/^/    /'

  echo "==> 6/10 build"
  npm run build || fail "6/10 build"

  echo "==> 7/10 restart"
  if pm2 describe bkh-wait > /dev/null 2>&1; then
    pm2 restart bkh-wait --update-env || fail "7/10 pm2 restart"
  else
    pm2 start npm --name bkh-wait --cwd "$APP_DIR" -- start || fail "7/10 pm2 start"
  fi
  pm2 save > /dev/null 2>&1

  echo "==> 8/10 OPD first sync"
  if [ ! -f scripts/sync-opd.mjs ]; then
    echo "    no OPD worker in this version"
  elif crontab -l 2>/dev/null | grep -qF 'scripts/sync-opd.mjs'; then
    echo "    OPD already installed (cron line present)"
    # db/009 wait segments for days finalized before it (only those columns change)
    node --env-file="$APP_DIR/.env.sync" scripts/sync-opd.mjs --resegment=30 >> "$LOG_DIR/sync-opd.log" 2>&1 \
      || { tail -n 1 "$LOG_DIR/sync-opd.log"; fail "8/10 OPD resegment"; }
    tail -n 1 "$LOG_DIR/sync-opd.log" | sed 's/^/    /'
  else
    node --env-file="$APP_DIR/.env.sync" scripts/sync-opd.mjs --backfill=30 >> "$LOG_DIR/sync-opd.log" 2>&1 \
      || { tail -n 1 "$LOG_DIR/sync-opd.log"; fail "8/10 first OPD sync"; }
    tail -n 1 "$LOG_DIR/sync-opd.log" | sed 's/^/    /'
  fi

  echo "==> 9/10 cron"
  ensure_cron 'scripts/sync-hosxp.mjs' "$BED_CRON" || fail "9/10 crontab (beds)"
  if [ -f scripts/sync-opd.mjs ]; then
    ensure_cron 'scripts/sync-opd.mjs' "$OPD_CRON" || fail "9/10 crontab (OPD)"
  fi
  crontab -l 2>/dev/null | grep -F "$APP_DIR" | sed 's/^/    /'

  echo "==> 10/10 check"
  BODY=""
  # The app needs a while after pm2 restart; nginx answers 502 until then.
  for _ in $(seq 1 30); do
    BODY="$(curl -sk --max-time 5 https://127.0.0.1:84/api/board 2>/dev/null)"
    printf "%s" "$BODY" | grep -q "\"bedSlots\"" && break
    sleep 3
  done
  if printf '%s' "$BODY" | grep -q '"bedSlots"'; then
    echo "    /api/board ok (bedSlots present)"
  else
    printf '    %s\n' "$(printf '%s' "${BODY:-no answer from https://127.0.0.1:84/api/board}" | head -c 200)"
    fail "10/10 /api/board"
  fi
  CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 'https://127.0.0.1:84/api/beds/occupants?ward=01')"
  [ "$CODE" = 401 ] || fail "10/10 /api/beds/occupants without login answered $CODE (expected 401)"
  echo "    /api/beds/occupants without login: 401 ok"
  echo "Done. Board: https://10.10.10.159:84/ ; logs: $LOG_DIR/sync.log $LOG_DIR/sync-opd.log"
}

main "$@"
