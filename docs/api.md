# bkh-wait API

All endpoints live under `/api`, return JSON and use the types in
`src/lib/beds/types.ts`. Only aggregate counts, ward configuration and
refer-back metadata cross the API — never patient names, CID, HN, AN or bed
numbers.

## Conventions

- **Errors** always have the shape `{ "error": string, "code": string }`
  (`error` is a Thai message safe to show in the UI).

  | HTTP | `code`                    | meaning                                                          |
  | ---- | ------------------------- | ---------------------------------------------------------------- |
  | 400  | `VALIDATION`              | bad body / query; `error` names the field                        |
  | 401  | `UNAUTHENTICATED`         | not logged in / session expired, or wrong username/password      |
  | 403  | `FORBIDDEN`               | role not allowed, or cross-site request blocked                  |
  | 404  | `NOT_FOUND`               | refer request id does not exist                                  |
  | 409  | `INVALID_TRANSITION`      | status change not allowed from the current status                |
  | 415  | `UNSUPPORTED_MEDIA_TYPE`  | write request without `Content-Type: application/json`           |
  | 429  | `TOO_MANY_ATTEMPTS`       | too many failed logins; `Retry-After` header (seconds)           |
  | 503  | `AUTH_NOT_CONFIGURED`     | `WAIT_SESSION_SECRET` not set on the server — login disabled     |
  | 503  | `WAIT_DB_NOT_CONFIGURED`  | PostgreSQL (`WAIT_DATABASE_URL`) not set — refer/config features off |
  | 503  | `HIS_UNAVAILABLE`         | HOSxP could not be read                                          |
  | 500  | `INTERNAL`                | anything else                                                    |

- **Writes** (`POST`, `PUT`, `PATCH`) must send
  `Content-Type: application/json` from a page of this site: the `Origin`
  header must match the host (else 403). The session cookie is `httpOnly`;
  plain `fetch(url, { method, headers, body })` sends it (same-origin).
- Timestamps are ISO 8601 strings in UTC (`...Z`). Show them in Asia/Bangkok.
- Responses are `Cache-Control: private, no-store` unless stated otherwise.

## Auth

Accounts are configured on the server (env `WAIT_USERS`). Roles:

| role      | who                                   | can                                                      |
| --------- | ------------------------------------- | -------------------------------------------------------- |
| `staff`   | Bangrakam ward / refer staff          | everything: list, create, any status change, departments |
| `partner` | regional hospital refer centre        | list, create; cancel only requests it created            |

### `POST /api/login`
Body `{ "username": string, "password": string }`
- 200 `{ "user": { "username": string, "role": "staff" | "partner" } }` and sets
  the httpOnly cookie `bkh_wait_session` (12 h)
- 401 `UNAUTHENTICATED` (same message for unknown user and wrong password)
- 429 `TOO_MANY_ATTEMPTS` (failed logins per 5 min: 5 per IP+username,
  20 per IP, 10 per username from any IP), 503 `AUTH_NOT_CONFIGURED`

### `POST /api/logout`
No body. 200 `{ "ok": true }`, clears the cookie. Always succeeds.

### `GET /api/session`
200 `{ "user": { "username": string, "role": "staff" | "partner" } | null }`
— use it to decide whether to show login / refer forms.

## Board (public)

### `GET /api/board`
200 `BedBoard`. Public (aggregate counts only).
`Cache-Control: public, max-age=15, stale-while-revalidate=45`; the server
also memoises the board for 10 s. 503 `HIS_UNAVAILABLE` when HOSxP is down.

Which wards: HOSxP `ward.ward_active = 'Y'`, minus **virtual** wards
(`ward_config.is_virtual`; ward 17 Home Ward by default, also when
PostgreSQL is not configured) and wards hidden with `visible = false`.
Virtual wards appear nowhere: not in `wards`, `departments`, `bySpclty` or
`totals`. Order: `ward_config.sort_order`, then ward code.

Per ward (`WardOccupancy`):

| field             | meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `wardName`        | `ward_config.display_name`, else HOSxP `ward.name`                                               |
| `beds`            | เตียงทั้งหมด: `ward_config.bed_capacity`, else physical beds (HOSxP `bedno` ⨝ `roomno` per `roomno.ward`), else `ward.bedcount` |
| `occupied`        | patients currently admitted: `ipt.dchdate IS NULL` and admitted within the last 180 days (older never-discharged rows are data-entry leftovers) |
| `occupiedNoBed`   | patients without a bed of their own: `occupied` − distinct `iptadm.bedno` in use                 |
| beds in use       | เตียงคนนอน = `occupied - occupiedNoBed` (not a field; compute in the UI)                          |
| `available`       | เตียงว่าง = `max(beds - (occupied - occupiedNoBed), 0)`                                          |
| `occupancyPct`    | `(beds - available) / beds * 100`, 1 decimal, 0 when `beds = 0`                                  |
| `admittedToday`   | `ipt.regdate = today`                                                                            |
| `dischargedToday` | `ipt.dchdate = today`                                                                            |
| `referWaiting`    | refer-back requests with status `waiting` for this ward (0 without PostgreSQL)                   |
| `departmentCode`  | the group in `departments[]` this ward belongs to (see below)                                    |
| `byDepartment`    | current patients of the ward split by HOSxP `ipt.spclty` (most first)                            |

`departments[]` (`DepartmentOccupancy`) — the bed departments (แผนก):
- ward with `ward_config.department_code` → that department (`wait.department`);
- ward with a `ward_config` row but no department → `"_none"` / `"ไม่ระบุแผนก"`;
- ward without a `ward_config` row (or no PostgreSQL) → its most frequent
  `spclty` over the last year, code `"sp-<spclty>"` (e.g. `"sp-01"` อายุรกรรม).

Sums over its wards (`beds`, `occupied`, `occupiedNoBed`, `available`,
`referWaiting`), `occupancyPct` from the sums, `byDepartment` merged.
Ordered by `department.sort_order`; fallback groups after configured ones,
`"_none"` last.

`bySpclty`: hospital-wide current patients by spclty (shown wards only).
`totals`: sums over `wards`; `totals.referWaiting` counts every waiting
request, including those without a ward.

### `GET /api/trend?hours=24&ward=01`
`hours`: integer 1–168 (default 24). `ward` optional.
200 `{ "hours": number, "configured": boolean, "points": OccupancyPoint[] }`
— ordered by `at`, then `wardCode`; one point per ward every 15 minutes
(virtual / hidden wards excluded). `occupied` = patients in the ward,
`beds` = capacity at that time, `bedsInUse` = beds in use (เตียงคนนอน) at
that time, `null` for points taken before migration 002. Without PostgreSQL: `configured: false`,
`points: []` (not an error). `Cache-Control: public, max-age=60`.

## Departments (bed grouping)

### `GET /api/departments` (public)
```json
{
  "departments": [
    { "departmentCode": "med", "name": "อายุรกรรม", "sortOrder": 10, "wardCodes": ["01", "02"] }
  ],
  "wards": [
    {
      "wardCode": "01", "hisName": "…", "hisBeds": 60,
      "displayName": null, "bedCapacity": null,
      "visible": true, "isVirtual": false, "sortOrder": 10,
      "departmentCode": "med"
    }
  ]
}
```
`wards` lists every active HOSxP ward (virtual ones included, so staff can
see / change the flag). 503 `WAIT_DB_NOT_CONFIGURED` without PostgreSQL.

### `PUT /api/departments` (role `staff`)
Body — the full department list plus any wards to change:
```json
{
  "departments": [
    { "departmentCode": "med", "name": "อายุรกรรม", "sortOrder": 10 }
  ],
  "wards": [
    { "wardCode": "01", "departmentCode": "med", "displayName": null,
      "bedCapacity": null, "visible": true, "isVirtual": false, "sortOrder": 10 }
  ]
}
```
- `departmentCode`: `^[a-z0-9][a-z0-9_-]{0,19}$` (so `_none` is reserved), unique;
  `name` 1–60 chars; `sortOrder` integer (default list position × 10).
- Departments not in the list are **deleted**; their wards get no department.
- Each ward in `wards` is upserted (must be an active HOSxP ward; its
  `departmentCode` must be in `departments` or `null`). Omitted ward fields
  default to: `displayName`/`bedCapacity` `null`, `visible` `true`,
  `isVirtual` `false` (`true` for ward 17), `sortOrder` list position × 10.
  Wards not listed keep their current config.
- 200 = same shape as `GET`. Audit-logged.

## Refer-back requests (login required)

Status flow:

```
waiting ──► accepted ──► admitted
   │            │
   └──► cancelled ◄┘          (admitted and cancelled are final)
```

`waitMinutes`: requested → admitted (admitted), requested → cancelled
(cancelled), otherwise requested → now.

`mine`: `true` when the logged-in account created the request (computed
per session on every response; the creator's username is never sent). The
UI shows "ยกเลิก" to `partner` accounts only on rows with `mine: true`.

### `GET /api/refer`
Query (all optional): `status` comma list, e.g. `waiting,accepted` (default
all) · `ward` ward code · `days` requested within the last N days, 1–365
(default 30) · `limit` 1–500 (default 200).

200 `{ "requests": ReferBackRequest[] }`, newest first. A `partner` account
sees only the requests it created (always `mine: true`); `staff` sees all.
401 when not logged in, 503 `WAIT_DB_NOT_CONFIGURED`.

### `POST /api/refer` (roles `staff`, `partner`)
```json
{
  "caseRef": "string, 1-60 chars, required",
  "fromHospital": "string, 1-120 chars, required",
  "wardCode": "string | null — an active, non-virtual ward",
  "diagnosisNote": "string, 0-500 chars"
}
```
`caseRef` / `diagnosisNote` must not contain a 13-digit number (national
ID, dashes/spaces ignored) → 400, so no identifiers are stored.
201 `{ "request": ReferBackRequest }` (status `waiting`).

### `PATCH /api/refer/{id}` (roles `staff`, `partner`)
Body `{ "status": ReferStatus, "wardCode"?: string | null }`
- allowed: `waiting → accepted`, `accepted → admitted`, `waiting|accepted → cancelled`
- `wardCode` may be sent only with `accepted` (the ward that takes the
  patient; must be an active, non-virtual ward)
- `partner` may only send `cancelled`, and only for requests it created (403)

200 `{ "request": ReferBackRequest }`; 404 `NOT_FOUND`; 409 `INVALID_TRANSITION`.

## Internal

### `POST /api/snapshot`
Header `Authorization: Bearer <WAIT_SNAPSHOT_TOKEN>` (403 otherwise, or
when the token is not configured). Writes one `wait.occupancy_snapshot` row
per non-virtual active ward (timestamp truncated to the minute; repeats in
the same minute are ignored). Triggered by cron through `scripts/snapshot.mjs`
every 15 minutes; not for the UI.
200 `{ "takenAt": string, "wards": number }`.
