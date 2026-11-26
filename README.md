# bkh-wait — bed board / refer-back

Bed-occupancy and waiting dashboard for Bangrakam hospital (hospcode 11252).
The regional hospital sees, per ward and department, how many beds are free
so it can refer patients back, and files refer-back requests that Bangrakam
staff accept / admit.

- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- **HOSxP** (MySQL, read-only): live census — `src/lib/db/his.ts`, `src/lib/beds/his-source.ts`
- **PostgreSQL** `bkh_wait`, schema `wait`: ward config, departments,
  refer-back requests, occupancy history, audit log — `src/lib/db/pg.ts`, `db/`
- API contract: [`docs/api.md`](docs/api.md); shared types: `src/lib/beds/types.ts`

Only aggregate counts leave the server; no patient identifiers are stored
or sent (refer-back requests carry a case reference of the sending hospital,
13-digit IDs are rejected).

## Bed definitions (HOSxP)

| | |
|---|---|
| wards | `ward.ward_active = 'Y'`, minus virtual wards (`ward_config.is_virtual`, ward 17 Home Ward) and hidden ones |
| beds (เตียงทั้งหมด) | `ward_config.bed_capacity`, else `bedno ⨝ roomno` per `roomno.ward`, else `ward.bedcount` |
| patients | `ipt.dchdate IS NULL AND ipt.regdate >= CURDATE() - INTERVAL 180 DAY` (`ipt.ward` = current ward) |
| beds in use (เตียงคนนอน) | distinct `iptadm.bedno` of those patients |
| free (เตียงว่าง) | `max(beds - beds in use, 0)` |
| department | `ward_config.department_code` → `wait.department`; fallback: ward's dominant `ipt.spclty` |

180-day cutoff: 10 never-discharged `ipt` rows from 2024-07..2025-01 (ward
NULL) are leftovers; the longest real stay in two years was 90 days.

## Development

```bash
cp .env.example .env      # fill HIS_* (+ WAIT_* if you have a PostgreSQL)
npm ci
npm run dev               # http://localhost:3001
npx tsc --noEmit && npm run lint
```

SQL research against HOSxP only through `node .claude/skills/db-cli/scripts/query.mjs`.

Staff account for `WAIT_USERS`:

```bash
node scripts/hash-password.mjs alice staff      # prompts for the password
```

## Production (server 10.10.10.159, mirrors bkh-kpi on :82)

Path `/var/www/wait`, deploy only `main`. pm2 process `bkh-wait` on
`127.0.0.1:3084`, nginx listens on **:84** and proxies to it (ports < 1024
need root, so Node does not bind 84 itself). nginx must forward
`Host $http_host` so the Origin (CSRF) check matches.

```bash
cd /var/www/wait
git fetch origin main && git reset --hard origin/main
cp -n .env.example .env && chmod 600 .env && nano .env   # first time
bash scripts/db-setup.sh            # first time: creates bkh_wait + roles, runs migrations
npm ci --no-audit --no-fund && npm run build
npm run db:migrate                  # every deploy (no-op when up to date)
pm2 start npm --name bkh-wait --cwd /var/www/wait -- start -- -H 127.0.0.1 -p 3084   # first time
pm2 restart bkh-wait --update-env   # later deploys
pm2 save
```

nginx site (`/etc/nginx/sites-available/bkh-wait`), same as bkh-kpi:

```nginx
server {
    listen 84;
    location / {
        proxy_pass http://127.0.0.1:3084;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

If :84 is plain HTTP, set `WAIT_COOKIE_INSECURE=true` or login cookies are
dropped by the browser.

### Occupancy snapshots (every 15 min)

Set `WAIT_SNAPSHOT_TOKEN` in `.env`, then `crontab -e` as bkhadmin:

```cron
*/15 * * * * cd /var/www/wait && /usr/bin/node --env-file=.env scripts/snapshot.mjs >> /var/www/wait/logs/snapshot.log 2>&1
```

(`mkdir -p /var/www/wait/logs` once.) The script only calls
`POST /api/snapshot`; the SQL lives in the app.

## Migrations

`db/NNN_name.sql`, applied in order by `npm run db:migrate` (one
transaction per file, checksums in `wait.schema_migrations`). Never edit an
applied file — add `002_….sql`. `db/setup.sql` is the one-time
database/role creation run by `scripts/db-setup.sh`.
