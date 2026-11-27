# bkh-wait — bed board / refer-back / OPD waiting

Bed-occupancy and waiting dashboard for Bangrakam hospital (hospcode 11252).
The regional hospital sees, per ward and department, how many beds are free
so it can refer patients back, and files refer-back requests that Bangrakam
staff accept / admit. A machine API sends daily bed census to the central /
regional level. The OPD board (`/opd`) shows, per clinic, how long
patients wait from registration to the doctor (การรอคอยการพบแพทย์แต่ละแผนก).

- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- **PostgreSQL** `bkh_wait`, schema `wait`: the ONLY database the web app
  talks to — `src/lib/db/pg.ts`, `db/`
- **HOSxP** (MySQL, read-only) is read ONLY by the sync workers
  `scripts/sync-hosxp.mjs` (beds, cron every 15 min) and `scripts/sync-opd.mjs`
  (OPD waits, cron every 5 min 06:00-20:55), which have their own env file
  `.env.sync`. The web app has no HOSxP credentials.
- API contract: [`docs/api.md`](docs/api.md); shared types: `src/lib/beds/types.ts`,
  `src/lib/opd/types.ts`

Only aggregate counts leave the server (refer-back requests carry a case
reference of the sending hospital, 13-digit IDs are rejected). The ONE
patient identifier kept is the **HN per occupied bed** (`wait.bed_occupant`,
db/006) for the 3D bed scene: staff tap a bed and see the HN. It is
readable only by logged-in `staff` through `GET /api/beds/occupants`; the
app's database role cannot SELECT the table and goes through the
`SECURITY DEFINER` function `wait.bed_occupants_for_ward`, which writes an
`audit_log` row (`view_hn`) for every view. Never in the public board or
the central API. No AN, names or CID are stored anywhere.

## Architecture

```
HOSxP (MySQL, SELECT-only account)
   │  every 15 min, cron: node --env-file=.env.sync scripts/sync-hosxp.mjs
   ▼                      (HIS_* + role bkh_wait_sync, one transaction per run)
PostgreSQL bkh_wait.wait
   his_ward, his_spclty           ward / spclty names, HOSxP bed capacity
   ward_state, ward_spclty_state  current census (last successful sync)
   bed_slot                       physical beds + occupied flag (public)
   bed_occupant                   RESTRICTED: HN per occupied bed; app reads it only via
                                  bed_occupants_for_ward() (audited), sync role write-only
   occupancy_snapshot             history, one row per ward per sync
   daily_census                   one row per (date, ward), finalized after midnight
   sync_run                       one row per run (job beds | opd, ok / error code)
   his_opd_clinic, opd_route      OPD clinics (kskdepartment) + department -> clinic routes
   opd_state, opd_hourly          OPD waits now / per hour (scripts/sync-opd.mjs, every 5 min)
   opd_daily                      one row per (date, clinic), finalized the next day
   opd_clinic_config              staff overrides of clinic name / visible / order (SQL)
   ward_config, department        staff overrides (PUT /api/departments)
   ward_catalog (view)            HOSxP wards + overrides = the one definition
   │                              of name, capacity, virtual, department
   ▼  role bkh_wait_app (SELECT on the sync tables)
Next.js web app (pm2, 127.0.0.1:3084, nginx :84)
   /            board (asOf = last sync, "stale" warning after 30 min)
   /api/board, /api/trend, /api/refer, /api/departments
   /api/beds/occupants            HN per bed, staff session only, audited
   /opd         OPD board (stale after 15 min during 06:15-20:30)
   /api/opd/board
   /api/v1/census, /api/v1/beds/current, /api/v1/opd/current, /api/v1/opd/daily
                                          central API (Bearer key)
```

## Bed definitions (HOSxP, `scripts/lib/hosxp.mjs`)

| | |
|---|---|
| wards | `ward.ward_active = 'Y'`, minus virtual wards (`ward_config.is_virtual`, ward 17 Home Ward) and hidden ones |
| beds (เตียงทั้งหมด) | `ward_config.bed_capacity`, else `bedno ⨝ roomno` per `roomno.ward`, else `ward.bedcount` |
| patients | `ipt.dchdate IS NULL AND ipt.regdate >= CURDATE() - INTERVAL 180 DAY` (`ipt.ward` = current ward) |
| beds in use (เตียงคนนอน) | distinct `iptadm.bedno` of those patients (bed of their current ward) |
| free (เตียงว่าง) | `max(beds - beds in use, 0)` |
| bed slots | every `bedno ⨝ roomno` of the ward, order `roomno`, `bed_order`, `bedno`; occupied = a current patient of the ward has it in `iptadm.bedno` |
| department | `ward_config.department_code` → `wait.department`; fallback: ward's dominant `ipt.spclty` |
| admitted / discharged (day D) | `ipt.regdate = D` / `ipt.dchdate = D` |
| patient days (day D) | midnight census: `regdate <= D AND (dchdate IS NULL OR dchdate > D)`, same 180-day cutoff |

180-day cutoff: a few never-discharged `ipt` rows from 2024-07..2025-01
(ward NULL) are leftovers; the longest real stay in two years was 90 days.

## OPD definitions (HOSxP, `scripts/lib/hosxp-opd.mjs`)

Wait = registration (`ovst.vstdate + vsttime`) → first `ovst_service_time`
row of type `OPD-DOCTOR` at a doctor-exam clinic. Clinics, routes, the
waiting / stale rules and the estimate are defined in the header of
`scripts/lib/hosxp-opd.mjs` and in [`docs/api.md`](docs/api.md) "OPD".
Rename / hide / order a clinic (until there is a settings page):

```sql
INSERT INTO wait.opd_clinic_config (clinic_code, display_name, visible, sort_order, updated_by)
VALUES ('001', 'ห้องตรวจโรคทั่วไป', true, 10, 'admin')
ON CONFLICT (clinic_code) DO UPDATE SET display_name = EXCLUDED.display_name,
  visible = EXCLUDED.visible, sort_order = EXCLUDED.sort_order, updated_at = now();
```

## Development

```bash
cp .env.example .env            # WAIT_* (PostgreSQL), session secret, users
cp .env.sync.example .env.sync  # HIS_* + WAIT_SYNC_DATABASE_URL (sync worker)
npm ci
npm run dev                     # http://localhost:3001
npm run sync:dry                # read HOSxP, print what would be written (no PostgreSQL)
npm run sync:opd:dry            # same for the OPD worker (add -- --date=YYYY-MM-DD for a past day)
npx tsc --noEmit && npm run lint
```

Without PostgreSQL the board answers 503 (`WAIT_DB_NOT_CONFIGURED`); it
shows data only after one successful sync (`SYNC_NOT_READY` before).

SQL research against HOSxP only through `node .claude/skills/db-cli/scripts/query.mjs`.

Backup account for `WAIT_USERS` (role `admin`, `staff` or `partner`):

```bash
node scripts/hash-password.mjs alice admin      # prompts for the password
```

Central API key for `WAIT_API_KEYS` (prints the key once + the hash entry):

```bash
node scripts/make-api-key.mjs moph-region3
```

## Sign-in and user management (same as bkh-kpi :82)

`/login` offers, in this order:

1. **เข้าสู่ระบบด้วย Provider ID** — PLK Health ID / MOPH Provider ID
   (OIDC via Auth.js). Shown only when `AUTH_PLKHEALTH_ISSUER`, `_ID`,
   `_SECRET` and `_REDIRECT_URI` (path `/auth/callback`) are set.
   `AUTH_PLKHEALTH_ALLOWED_ORGS` must list the allowed hospcodes — empty
   denies every SSO sign-in. A first sign-in creates a **pending** row in
   `wait.app_user`; an admin approves / rejects it or grants admin at
   `/admin/users`. `AUTH_ADMIN_SUBS` subs are always approved admins.
2. **รหัสสำหรับบุคคลภายนอก** — per-person code issued by an admin at
   `/admin/access-codes` (name, organisation, expiry default 7 days, max
   90). The code is shown once; only an HMAC (`WAIT_ACCESS_CODE_SECRET`) is
   stored in `wait.access_code`. Revoking keeps the record. A code session
   is role `partner`: boards + own refer-back requests, never HN.
3. **บัญชีสำรอง** (collapsed) — `WAIT_USERS` username / password, for when
   SSO is not available. Keep one `admin` entry here until Provider ID works
   on :84, so someone can approve users and issue codes.

Every request re-reads the user / code store, so approvals, role changes
and revocations apply immediately; sessions last at most 8 h. HN views
(`/api/beds/occupants`, staff / admin only) are audited with an actor that
names the person (`sso:<sub>:<name>`, `local:<user>`). Logins and admin
actions are in `wait.audit_log` (`action LIKE 'auth.%'`, `user.update`,
`access_code.%`).

**Before Provider ID works on :84** the IdP must accept the redirect URI
`https://10.10.10.159:84/auth/callback` for the client in
`AUTH_PLKHEALTH_ID` (ask the PLK Health ID / Provider ID administrators to
register it, or issue a separate client and put its id / secret in
`/var/www/wait/.env`). Until then the button fails at the IdP; use the
backup account or access codes. Cookies are app specific
(`bkh-wait.*`), so being signed in to bkh-kpi on :82 does not interfere.

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

Every later deploy (including the OPD board and the bed-HN upgrade):

```bash
cd /var/www/wait && git fetch origin main && git reset --hard origin/main
bash scripts/server-upgrade.sh
```

`scripts/server-upgrade.sh` (as bkhadmin, no sudo, safe to re-run): git
reset to origin/main, auth settings in `.env` (copies `AUTH_PLKHEALTH_ISSUER`
/ `_ID` / `_SECRET` / `_ALLOWED_ORGS` and `AUTH_ADMIN_SUBS` from
`/var/www/kpi/.env` when missing, sets `AUTH_PLKHEALTH_REDIRECT_URI` to
`https://10.10.10.159:84/auth/callback` when missing, generates
`AUTH_SECRET` / `WAIT_ACCESS_CODE_SECRET` when missing; never prints
values), npm ci, preflight dry run of both workers, pending
migrations (005 OPD, 006 bed slots / occupants, 007 sign-in, ...), one bed sync,
build, pm2 restart, first OPD sync with 30 days backfill when OPD is new,
adds the bed / OPD cron lines if missing, then checks `/api/board` has
`bedSlots` and `/api/beds/occupants` answers 401 without login.
`scripts/server-upgrade-opd.sh` is now a wrapper around it.

Upgrade notes for 007 (sign-in like bkh-kpi):
- Additive: tables `app_user`, `access_code` (app role: no DELETE).
- Everybody signs in again once (new Auth.js cookie; the old
  `bkh_wait_session` cookie is ignored). Existing `WAIT_USERS` keep
  working as the backup login; refer requests they created stay "mine".
- After the upgrade: sign in with a `WAIT_USERS` admin (or an
  `AUTH_ADMIN_SUBS` Provider ID account once the :84 redirect URI is
  registered) and approve staff at `/admin/users`.

Upgrade notes for 006 (bed HN):
- Additive: new tables `bed_slot`, `bed_occupant`, function
  `bed_occupants_for_ward`. The app needs 006 before it starts (the board
  reads `bed_slot`) — the script migrates before the restart.
- From now on the PostgreSQL database (and its backups) holds the HN of
  current inpatients. Keep backups as protected as HOSxP's.
- Audit of HN views:
  `SELECT at, actor, entity_id AS ward, detail->>'rows' AS rows FROM wait.audit_log WHERE action = 'view_hn' ORDER BY at DESC LIMIT 50;`

### Env files (both mode 0600, never committed)

| file | used by | holds |
|---|---|---|
| `.env` | web app (Next reads it), `db:migrate` | `WAIT_DATABASE_URL` (role `bkh_wait_app`), `WAIT_MIGRATE_DATABASE_URL` (owner), `AUTH_SECRET` (or older `WAIT_SESSION_SECRET`), `WAIT_ACCESS_CODE_SECRET`, `AUTH_PLKHEALTH_*`, `AUTH_ADMIN_SUBS`, `AUTH_BOOTSTRAP_ADMIN_FNAMES`, `WAIT_USERS`, `WAIT_API_KEYS`, `WAIT_API_CORS_ORIGINS`, `AUTH_COOKIE_INSECURE` |
| `.env.sync` | sync worker only | `HIS_HOST/PORT/USER/PASSWORD/DATABASE`, `WAIT_SYNC_DATABASE_URL` (role `bkh_wait_sync`) |

### Sync workers (beds every 15 min, OPD every 5 min 06:00-20:55)

```cron
*/15 * * * * cd /var/www/wait && /usr/bin/node --env-file=/var/www/wait/.env.sync scripts/sync-hosxp.mjs >> /var/www/wait/logs/sync.log 2>&1
```

Each run logs one line (`sync ok: run N, 8 ward(s), ...` or
`sync FAILED: HIS_ECONNREFUSED`) and writes a `wait.sync_run` row. Failures
never contain hosts or passwords. `--dry-run` reads HOSxP only and prints
the aggregates. The board flags data older than 30 minutes as stale.

```cron
*/5 6-20 * * * cd /var/www/wait && /usr/bin/node --env-file=/var/www/wait/.env.sync scripts/sync-opd.mjs >> /var/www/wait/logs/sync-opd.log 2>&1
```

OPD runs log `opd sync ok: run N, <date>, 14 clinic(s), waiting W, seen S ...`
(own advisory lock, `sync_run.job = 'opd'`). The first run of a day finalizes
the earlier open days of `opd_daily`; `--backfill=N` fills up to 92 past days
that have no rows yet.

## Migrations

`db/NNN_name.sql`, applied in order by `npm run db:migrate` (one
transaction per file, checksums in `wait.schema_migrations`). Never edit an
applied file — add a new number. `db/setup.sql` is the one-time
database/role creation run by `scripts/db-setup.sh`; `db/sync-role.sql`
(via `scripts/db-sync-role.sh`, as postgres) creates the sync role, which
the owner role may not do.
