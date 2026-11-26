# bkh-wait — bed board / refer-back

Bed-occupancy and waiting dashboard for Bangrakam hospital (hospcode 11252).
The regional hospital sees, per ward and department, how many beds are free
so it can refer patients back, and files refer-back requests that Bangrakam
staff accept / admit. A machine API sends daily bed census to the central /
regional level.

- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- **PostgreSQL** `bkh_wait`, schema `wait`: the ONLY database the web app
  talks to — `src/lib/db/pg.ts`, `db/`
- **HOSxP** (MySQL, read-only) is read ONLY by the sync worker
  `scripts/sync-hosxp.mjs` (cron, every 15 min), which has its own env file
  `.env.sync`. The web app has no HOSxP credentials.
- API contract: [`docs/api.md`](docs/api.md); shared types: `src/lib/beds/types.ts`

Only aggregate counts leave the server; no patient identifiers are stored
or sent (refer-back requests carry a case reference of the sending hospital,
13-digit IDs are rejected).

## Architecture

```
HOSxP (MySQL, SELECT-only account)
   │  every 15 min, cron: node --env-file=.env.sync scripts/sync-hosxp.mjs
   ▼                      (HIS_* + role bkh_wait_sync, one transaction per run)
PostgreSQL bkh_wait.wait
   his_ward, his_spclty           ward / spclty names, HOSxP bed capacity
   ward_state, ward_spclty_state  current census (last successful sync)
   occupancy_snapshot             history, one row per ward per sync
   daily_census                   one row per (date, ward), finalized after midnight
   sync_run                       one row per run (ok / error code)
   ward_config, department        staff overrides (PUT /api/departments)
   ward_catalog (view)            HOSxP wards + overrides = the one definition
   │                              of name, capacity, virtual, department
   ▼  role bkh_wait_app (SELECT on the sync tables)
Next.js web app (pm2, 127.0.0.1:3084, nginx :84)
   /            board (asOf = last sync, "stale" warning after 30 min)
   /api/board, /api/trend, /api/refer, /api/departments
   /api/v1/census, /api/v1/beds/current   central API (Bearer key)
```

## Bed definitions (HOSxP, `scripts/lib/hosxp.mjs`)

| | |
|---|---|
| wards | `ward.ward_active = 'Y'`, minus virtual wards (`ward_config.is_virtual`, ward 17 Home Ward) and hidden ones |
| beds (เตียงทั้งหมด) | `ward_config.bed_capacity`, else `bedno ⨝ roomno` per `roomno.ward`, else `ward.bedcount` |
| patients | `ipt.dchdate IS NULL AND ipt.regdate >= CURDATE() - INTERVAL 180 DAY` (`ipt.ward` = current ward) |
| beds in use (เตียงคนนอน) | distinct `iptadm.bedno` of those patients (bed of their current ward) |
| free (เตียงว่าง) | `max(beds - beds in use, 0)` |
| department | `ward_config.department_code` → `wait.department`; fallback: ward's dominant `ipt.spclty` |
| admitted / discharged (day D) | `ipt.regdate = D` / `ipt.dchdate = D` |
| patient days (day D) | midnight census: `regdate <= D AND (dchdate IS NULL OR dchdate > D)`, same 180-day cutoff |

180-day cutoff: a few never-discharged `ipt` rows from 2024-07..2025-01
(ward NULL) are leftovers; the longest real stay in two years was 90 days.

## Development

```bash
cp .env.example .env            # WAIT_* (PostgreSQL), session secret, users
cp .env.sync.example .env.sync  # HIS_* + WAIT_SYNC_DATABASE_URL (sync worker)
npm ci
npm run dev                     # http://localhost:3001
npm run sync:dry                # read HOSxP, print what would be written (no PostgreSQL)
npx tsc --noEmit && npm run lint
```

Without PostgreSQL the board answers 503 (`WAIT_DB_NOT_CONFIGURED`); it
shows data only after one successful sync (`SYNC_NOT_READY` before).

SQL research against HOSxP only through `node .claude/skills/db-cli/scripts/query.mjs`.

Staff account for `WAIT_USERS`:

```bash
node scripts/hash-password.mjs alice staff      # prompts for the password
```

Central API key for `WAIT_API_KEYS` (prints the key once + the hash entry):

```bash
node scripts/make-api-key.mjs moph-region3
```

## Production (server 10.10.10.159, mirrors bkh-kpi on :82)

Path `/var/www/wait`, deploy only `main`. pm2 process `bkh-wait` on
`127.0.0.1:3084`, nginx listens on **:84** (https) and proxies to it.

- New server: `scripts/server-first-deploy.sh` (see its header).
- Existing install from before the sync worker (HIS_* in `.env`, cron
  `snapshot.mjs`): `bash scripts/server-upgrade-sync.sh` once — moves HIS_*
  to `.env.sync`, creates role `bkh_wait_sync`, checks HOSxP (dry run),
  runs migration 003, the first sync, rebuilds, swaps the cron line,
  restarts, then migration 004 (snapshots read-only for the app). A failure
  before the switch leaves the old app and its cron working; fix and
  re-run. Existing history is kept.

Later deploys:

```bash
cd /var/www/wait
git fetch origin main && git reset --hard origin/main
npm ci --no-audit --no-fund && npm run build
npm run db:migrate                  # no-op when up to date
pm2 restart bkh-wait --update-env
```

### Env files (both mode 0600, never committed)

| file | used by | holds |
|---|---|---|
| `.env` | web app (Next reads it), `db:migrate` | `WAIT_DATABASE_URL` (role `bkh_wait_app`), `WAIT_MIGRATE_DATABASE_URL` (owner), `WAIT_SESSION_SECRET`, `WAIT_USERS`, `WAIT_API_KEYS`, `WAIT_API_CORS_ORIGINS`, `WAIT_COOKIE_INSECURE` |
| `.env.sync` | sync worker only | `HIS_HOST/PORT/USER/PASSWORD/DATABASE`, `WAIT_SYNC_DATABASE_URL` (role `bkh_wait_sync`) |

### Sync worker (every 15 min)

```cron
*/15 * * * * cd /var/www/wait && /usr/bin/node --env-file=/var/www/wait/.env.sync scripts/sync-hosxp.mjs >> /var/www/wait/logs/sync.log 2>&1
```

Each run logs one line (`sync ok: run N, 8 ward(s), ...` or
`sync FAILED: HIS_ECONNREFUSED`) and writes a `wait.sync_run` row. Failures
never contain hosts or passwords. `--dry-run` reads HOSxP only and prints
the aggregates. The board flags data older than 30 minutes as stale.

## Migrations

`db/NNN_name.sql`, applied in order by `npm run db:migrate` (one
transaction per file, checksums in `wait.schema_migrations`). Never edit an
applied file — add a new number. `db/setup.sql` is the one-time
database/role creation run by `scripts/db-setup.sh`; `db/sync-role.sql`
(via `scripts/db-sync-role.sh`, as postgres) creates the sync role, which
the owner role may not do.
