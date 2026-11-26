#!/usr/bin/env bash
# Kept for the instructions that name it: the OPD upgrade is now part of the
# generic upgrade (git reset to origin/main, npm ci, preflight, migrations
# 005/006/..., bed sync, build, pm2 restart, first OPD sync with 30 days
# backfill, both cron lines). See scripts/server-upgrade.sh.
#
#   cd /var/www/wait && bash scripts/server-upgrade-opd.sh
cd /var/www/wait || { echo "cd /var/www/wait failed"; exit 1; }
exec bash scripts/server-upgrade.sh "$@"
