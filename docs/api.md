# bkh-wait API

All endpoints live under `/api`, return JSON and use the types in
`src/lib/beds/types.ts`. Only aggregate counts, ward configuration,
refer-back metadata and the public bed layout (bed numbers + occupied flag)
cross the API — never patient names, CID or AN. The ONE exception is the
HN per bed of `GET /api/beds/occupants`: logged-in `staff` only, every
view written to the audit log (see "Bed occupants").

## Conventions

- **Errors** always have the shape `{ "error": string, "code": string }`
  (`error` is a Thai message safe to show in the UI).

  | HTTP | `code`                    | meaning                                                          |
  | ---- | ------------------------- | ---------------------------------------------------------------- |
  | 400  | `VALIDATION`              | bad body / query; `error` names the field                        |
  | 401  | `UNAUTHENTICATED`         | not logged in / session expired, or wrong username/password      |
  | 403  | `FORBIDDEN`               | role not allowed, or cross-site request blocked                  |
  | 404  | `NOT_FOUND`               | refer request id / ward does not exist                           |
  | 409  | `INVALID_TRANSITION`      | status change not allowed from the current status                |
  | 415  | `UNSUPPORTED_MEDIA_TYPE`  | write request without `Content-Type: application/json`           |
  | 429  | `TOO_MANY_ATTEMPTS`       | reserved (sign-in limits now come back as `/login?code=rate_limited_N`) |
  | 503  | `AUTH_NOT_CONFIGURED`     | `AUTH_SECRET` / `WAIT_SESSION_SECRET` (or the access-code key) not set — login disabled |
  | 503  | `AUTH_STORE_UNAVAILABLE`  | user store (PostgreSQL) unreadable — access refused (fail closed) |
  | 409  | `CONFLICT`                | admin change not allowed (own account, env admin, last admin, too many codes) |
  | 503  | `WAIT_DB_NOT_CONFIGURED`  | PostgreSQL (`WAIT_DATABASE_URL`) not set — refer/config features off |
  | 429  | `RATE_LIMITED`            | central API: too many calls for this key / failed keys from this IP; bed occupants: too many calls for this user; `Retry-After` |
  | 503  | `SYNC_NOT_READY`          | no successful HOSxP sync yet (board has no data)                 |
  | 503  | `API_NOT_CONFIGURED`      | central API: `WAIT_API_KEYS` not set                             |
  | 500  | `INTERNAL`                | anything else                                                    |

- **Writes** (`POST`, `PUT`, `PATCH`) must send
  `Content-Type: application/json` from a page of this site: the `Origin`
  header must match the host (else 403). The session cookie is `httpOnly`;
  plain `fetch(url, { method, headers, body })` sends it (same-origin).
- Timestamps are ISO 8601 strings in UTC (`...Z`). Show them in Asia/Bangkok.
- Responses are `Cache-Control: private, no-store` unless stated otherwise.

## Auth

Sign-in uses Auth.js (next-auth v5), the same design as bkh-kpi (:82):

| method | how | session role |
| --- | --- | --- |
| Provider ID (PLK Health ID / MOPH Provider ID, OIDC) | button on `/login`; org allow-list `AUTH_PLKHEALTH_ALLOWED_ORGS` (empty = denied); new accounts wait for approval at `/admin/users` | `staff` or `admin` (from `wait.app_user`; `AUTH_ADMIN_SUBS` = always admin) |
| access code (outsiders) | "รหัสสำหรับบุคคลภายนอก" on `/login`; per-person code issued at `/admin/access-codes` (default 7 days, max 90) | `partner`, always |
| backup account (`WAIT_USERS`) | collapsed "บัญชีสำรอง" on `/login` | as configured: `admin` / `staff` / `partner` |

| role      | can                                                                 |
| --------- | ------------------------------------------------------------------- |
| `admin`   | everything `staff` can + `/admin/*`, `/api/admin/*`                 |
| `staff`   | refer list, create, any status change, departments, bed HN (audited) |
| `partner` | boards; list / create own requests, cancel only its own; **never HN** (`/api/beds/occupants` -> 403) |

- Session: encrypted cookie `__Secure-bkh-wait.session-token` (no prefix when
  cookies are insecure), absolute lifetime 8 h. Role and validity are
  re-read from env + PostgreSQL on **every** request: rejecting a user,
  changing a role, revoking a code or removing a `WAIT_USERS` entry applies
  on the next request.
- Endpoints `/api/auth/*` are Auth.js (`csrf`, `providers`, `signin/*`,
  `callback/*`, `signout`, `session`); browsers use `next-auth/react`
  `signIn` / `signOut` (CSRF token flow). `/auth/callback` is the redirect
  URI registered at the IdP and forwards to `/api/auth/callback/plkhealth`.
- Failed sign-ins redirect to `/login?error=<type>&code=<code>` (codes in
  `src/lib/auth/messages.ts`); 5 failed passwords per IP+user / 5 min and 5
  failed access codes per IP / 5 min, then `code=rate_limited_<minutes>`.
- Logins, logouts and admin actions are written to `wait.audit_log`
  (`auth.*`, `user.update`, `access_code.create|revoke`).
- `503 AUTH_STORE_UNAVAILABLE`: the user store (PostgreSQL) could not be
  read, so access is refused (fail closed).

### `GET /api/session`
200 `{ "user": { "username": string, "name": string, "role": "admin" | "staff" | "partner", "provider": "sso" | "code" | "local", "expiresAt"?: string } | null }`
— `username` is the principal id (`sso:<sub>`, `code:<id>` or the
`WAIT_USERS` name); `expiresAt` only for access codes.

### Admin (role `admin`; writes same-origin + `application/json`)
- `GET /api/admin/users` -> `{ users: AdminUser[], me: { sub } }`
- `PATCH /api/admin/users/{sub}` `{ status?: "pending"|"approved"|"rejected", role?: "admin"|"staff" }`
  -> `{ user }`; 409 `CONFLICT` for own account, `AUTH_ADMIN_SUBS` accounts
  and removing the last approved admin
- `GET /api/admin/access-codes` -> `{ codes }` (never hashes / plaintext)
- `POST /api/admin/access-codes` `{ name, org, expiresOn: "YYYY-MM-DD" }`
  -> 201 `{ code, plaintext }` — the only time the code is shown
- `DELETE /api/admin/access-codes/{id}` -> `{ code }` (revoked; row kept)

## Board (public)

### `GET /api/board`
200 `BedBoard`. Public (aggregate counts only).
`Cache-Control: public, max-age=15, stale-while-revalidate=45`; the server
also memoises the board for 10 s.

Source: PostgreSQL only — the last successful run of the HOSxP sync worker
(`scripts/sync-hosxp.mjs`, every 15 min). The web app never queries HOSxP.
- `asOf`: finish time of that sync run (ISO, UTC).
- `stale`: `true` when `asOf` is older than 30 minutes (sync not running);
  the UI shows a warning next to the timestamp.
- 503 `SYNC_NOT_READY` before the first successful sync,
  503 `WAIT_DB_NOT_CONFIGURED` without PostgreSQL.

Which wards: HOSxP `ward.ward_active = 'Y'`, minus **virtual** wards
(`ward_config.is_virtual`; ward 17 Home Ward by default) and wards hidden with `visible = false`.
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
| `bedSlots`        | the physical beds (`BedSlot[]`), see below — public, no patient data                             |

`bedSlots[]` (`BedSlot`): every HOSxP bed of the ward (`bedno` ⨝ `roomno`
on `roomno.ward`), ordered by `roomno`, `bed_order` (empty last), `bedno`.
`bedno` (HOSxP bed code, e.g. `"Y03"`), `bedName` (`bedno.bedname`, else
`bedno` — HOSxP has no bed names today), `roomName` (`roomno.name`) and
`occupied`: a current inpatient of this ward has this bed in `iptadm.bedno`
(the same set as beds in use, so `count(occupied) = occupied - occupiedNoBed`).
Patients without a bed of their own are not placed on any slot.
`bedSlots.length` is the HOSxP bed count and can differ from `beds` when
`ward_config.bed_capacity` overrides it. Written by the bed sync
(`wait.bed_slot`), same `asOf`.

`departments[]` (`DepartmentOccupancy`) — the bed departments (แผนก):
- ward with `ward_config.department_code` → that department (`wait.department`);
- ward with a `ward_config` row but no department → `"_none"` / `"ไม่ระบุแผนก"`;
- ward without a `ward_config` row → its most frequent
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
(virtual / hidden wards excluded), written by the sync worker. `occupied` = patients in the ward,
`beds` = capacity at that time, `bedsInUse` = beds in use (เตียงคนนอน) at
that time, `null` for points taken before migration 002. Without PostgreSQL: `configured: false`,
`points: []` (not an error). `Cache-Control: public, max-age=60`.

## Bed occupants (staff only, HN)

### `GET /api/beds/occupants?ward=01` (role `staff`)
Who lies in which bed of one ward — for the 3D bed scene: a staff member
taps a bed and sees the patient's HN.

200
```json
{
  "wardCode": "01",
  "asOf": "2026-11-26T03:15:04.120Z",
  "occupants": [
    { "bedno": "040", "bedName": "040", "hn": "<HN>", "admitDate": "2026-11-20",
      "lengthOfStayDays": 6, "spcltyName": "อายุรกรรม" }
  ]
}
```
`occupants` (`BedOccupant[]`) in `bedSlots` order; match them to the slots
by `bedno`. `lengthOfStayDays` = today (Asia/Bangkok) − `admitDate`.
`asOf` = the same bed sync as the board.

| status | when |
| ------ | ---- |
| 401 `UNAUTHENTICATED` | no / expired session |
| 403 `FORBIDDEN` | role `partner`, or a cross-site request (`Sec-Fetch-Site` other than `same-origin`/`none`, or a foreign `Origin`) |
| 400 `VALIDATION` | `ward` missing or not 1–4 letters/digits |
| 404 `NOT_FOUND` | ward not on the board (unknown, inactive, hidden or virtual) |
| 429 `RATE_LIMITED` | more than 30 calls per minute for this user; `Retry-After` |
| 503 | `SYNC_NOT_READY` / `WAIT_DB_NOT_CONFIGURED` |

Privacy rules:
- **HN is visible only to logged-in `staff`.** Never in `/api/board`, the
  trend, snapshots, the daily census or the central API (`/api/v1/*`).
- **Every view is audited.** The web app's database role cannot read
  `wait.bed_occupant`; it can only call `wait.bed_occupants_for_ward(ward,
  actor)` (db/006, `SECURITY DEFINER`), which returns the rows and appends
  one `wait.audit_log` row (`actor` = username, `action` = `view_hn`,
  `entity` = `ward`, `entity_id` = ward code, `detail.rows` = rows
  returned) in the same statement. The audit row never contains an HN.
  Review: `SELECT at, actor, entity_id, detail FROM wait.audit_log WHERE action = 'view_hn' ORDER BY at DESC;`
- `Cache-Control: private, no-store`, `Vary: Cookie`; never cached on the
  server (no memo). Fetch it when a bed is tapped, keep it in component
  state only (no localStorage / URL), drop it when the scene closes.
- Only the HN is stored (no AN, name or CID); the table is replaced on every
  bed sync, so discharged patients disappear within 15 minutes. Database
  backups now contain current inpatient HNs — protect them like HOSxP backups.

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
`wards` lists every active HOSxP ward as of the last sync (virtual ones included, so staff can
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

## API สำหรับส่วนกลาง

API แบบเครื่องต่อเครื่องสำหรับส่งข้อมูลเตียงให้ส่วนกลาง / เขตสุขภาพ ข้อมูลทั้งหมดอ่านจาก
PostgreSQL ของเราเอง (`bkh_wait`) ซึ่ง sync worker คัดลอกจาก HOSxP ทุก 15 นาที —
API นี้ **ไม่เชื่อมต่อ HOSxP** และส่งเฉพาะค่าสรุประดับหอผู้ป่วย / แผนก
(hospcode 11252) ไม่มีข้อมูลระบุตัวผู้ป่วย (ชื่อ, HN, AN, CID, เลขเตียง)

### การยืนยันตัวตน

- ทุกคำขอต้องส่ง header `Authorization: Bearer <key>`
- ผู้ดูแลระบบออก key ด้วย `node scripts/make-api-key.mjs <ชื่อผู้ใช้ API>` สคริปต์จะพิมพ์
  key (แสดงครั้งเดียว ส่งให้ส่วนกลางผ่านช่องทางที่ปลอดภัย) และรายการ `ชื่อ:sha256hex`
  ให้นำไปต่อท้าย `WAIT_API_KEYS` ใน `.env` ของเซิร์ฟเวอร์ (คั่นด้วย `,`) แล้ว
  `pm2 restart bkh-wait --update-env` — เซิร์ฟเวอร์เก็บเฉพาะค่า hash ยกเลิก key ได้โดยลบรายการนั้นออก
- เปรียบเทียบ key แบบ constant-time
- จำกัด 60 ครั้ง/นาที ต่อ key (เกินได้ 429 `RATE_LIMITED` พร้อม `Retry-After`)
  และ key ผิด 20 ครั้ง/5 นาที ต่อ IP จะถูกปฏิเสธชั่วคราว
- ทุกคำขอที่ยืนยันตัวตนผ่านจะถูกบันทึกใน `wait.audit_log`
  (`actor = api:<ชื่อ key>`, endpoint, ช่วงวันที่, HTTP status)
- CORS ปิดเป็นค่าเริ่มต้น (ไม่ส่ง header `Access-Control-*`) ถ้าจำเป็นต้องเรียกจาก
  เบราว์เซอร์ ให้ใส่ origin ที่อนุญาตใน `WAIT_API_CORS_ORIGINS`
- ไม่ได้ตั้ง `WAIT_API_KEYS` → 503 `API_NOT_CONFIGURED`; key ผิด/ไม่มี → 401 `UNAUTHENTICATED`
- ทุกคำตอบเป็น `Cache-Control: private, no-store` เวลาเป็น ISO 8601 (UTC) ส่วนวันที่
  (`date`, `from`, `to`) เป็นวันตามเวลาประเทศไทย (Asia/Bangkok)

### `GET /api/v1/beds/current`

สถานะเตียงปัจจุบัน (ผล sync ล่าสุด) — หอผู้ป่วยเดียวกับหน้า board
(ไม่รวมหอเสมือน เช่น 17 Home Ward และหอที่ซ่อน)

```bash
curl -s https://10.10.10.159:84/api/v1/beds/current \
  -H "Authorization: Bearer $BKH_WAIT_API_KEY"
```

```json
{
  "hospcode": "11252",
  "asOf": "2026-11-26T03:00:12.345Z",
  "stale": false,
  "totals": { "beds": 120, "bedsInUse": 50, "available": 70, "occupancyPct": 41.7, "patients": 52 },
  "departments": [
    {
      "departmentCode": "med", "departmentName": "อายุรกรรม", "wardCodes": ["01", "02"],
      "beds": 80, "bedsInUse": 40, "available": 40, "occupancyPct": 50, "patients": 41
    }
  ],
  "wards": [
    {
      "wardCode": "01", "wardName": "หอผู้ป่วยตัวอย่าง", "departmentCode": "med",
      "beds": 40, "bedsInUse": 20, "available": 20, "occupancyPct": 50, "patients": 21,
      "admittedToday": 3, "dischargedToday": 2
    }
  ]
}
```
(ตัวเลขในตัวอย่างเป็นค่าสมมติ)

| field | ความหมาย |
| --- | --- |
| `asOf` | เวลาที่ sync จาก HOSxP สำเร็จครั้งล่าสุด |
| `stale` | `true` เมื่อ `asOf` เก่ากว่า 30 นาที (sync ไม่ทำงาน — ข้อมูลอาจไม่เป็นปัจจุบัน) |
| `beds` | เตียงทั้งหมด (ค่าที่ รพ. กำหนด หรือจำนวนเตียงจริงใน HOSxP) |
| `bedsInUse` | เตียงที่มีผู้ป่วยนอน |
| `available` | เตียงว่าง = `max(beds - bedsInUse, 0)` |
| `occupancyPct` | `(beds - available) / beds * 100` ทศนิยม 1 ตำแหน่ง |
| `patients` | ผู้ป่วยในที่ยังไม่จำหน่าย (อาจมากกว่า `bedsInUse` เมื่อมีผู้ป่วยยังไม่ได้เตียง) |
| `admittedToday` / `dischargedToday` | รับใหม่ / จำหน่าย วันนี้ |

ข้อผิดพลาด: 503 `SYNC_NOT_READY` (ยังไม่เคย sync สำเร็จ), 503 `WAIT_DB_NOT_CONFIGURED`

### `GET /api/v1/census?from=YYYY-MM-DD&to=YYYY-MM-DD`

สถิติเตียงรายวัน รายหอผู้ป่วย (`wait.daily_census`) ช่วงวันที่รวมไม่เกิน **92 วัน**
(`from` ≤ `to`, นับรวมทั้งสองวัน) ผิดรูปแบบ → 400 `VALIDATION`

```bash
curl -s "https://10.10.10.159:84/api/v1/census?from=2026-11-01&to=2026-11-30" \
  -H "Authorization: Bearer $BKH_WAIT_API_KEY"
```

```json
{
  "hospcode": "11252",
  "from": "2026-11-01",
  "to": "2026-11-30",
  "generatedAt": "2026-11-26T03:05:00.000Z",
  "lastSyncAt": "2026-11-26T03:00:12.345Z",
  "stale": false,
  "days": [
    {
      "date": "2026-11-25", "finalized": true, "wards": 7,
      "beds": 120, "bedsInUse": 48, "available": 72, "occupancyPct": 40,
      "admitted": 20, "discharged": 22, "patientDays": 47
    }
  ],
  "rows": [
    {
      "date": "2026-11-25",
      "wardCode": "01", "wardName": "หอผู้ป่วยตัวอย่าง",
      "departmentCode": "med", "departmentName": "อายุรกรรม",
      "beds": 40, "bedsInUse": 19, "available": 21, "occupancyPct": 47.5,
      "peakBedsInUse": 23,
      "admitted": 8, "discharged": 9, "patientDays": 18,
      "finalized": true,
      "updatedAt": "2026-11-25T17:00:09.000Z"
    }
  ]
}
```
(ตัวเลขในตัวอย่างเป็นค่าสมมติ)

`rows` = หนึ่งแถวต่อ (วัน, หอผู้ป่วย) เรียงตามวันที่และลำดับหอ (`DailyCensus` ใน
`src/lib/beds/types.ts`); `days` = ผลรวมทั้งโรงพยาบาลของแต่ละวัน
(`finalized` = ทุกหอของวันนั้นปิดยอดแล้ว) วันที่ไม่มีข้อมูล (sync ยังไม่ทำงานในวันนั้น)
จะไม่มีแถว

| field | ความหมาย |
| --- | --- |
| `beds` | เตียงทั้งหมด ณ sync ล่าสุดของวันนั้น |
| `bedsInUse` | เตียงที่มีผู้ป่วยนอน ณ sync ล่าสุดของวันนั้น (วันที่ปิดแล้ว = sync สุดท้ายก่อนเที่ยงคืน) |
| `available`, `occupancyPct` | คำนวณจาก `beds` และ `bedsInUse` เช่นเดียวกับ beds/current |
| `peakBedsInUse` | เตียงที่มีผู้ป่วยนอนสูงสุดในบรรดาการ sync ของวันนั้น |
| `admitted` | รับใหม่ในวันนั้น (`ipt.regdate`) |
| `discharged` | จำหน่ายในวันนั้น (`ipt.dchdate`) |
| `patientDays` | วันนอน = จำนวนผู้ป่วยที่ยังนอนอยู่ ณ เที่ยงคืนสิ้นวัน (midnight census) |
| `finalized` | `false` = วันนี้ (ตัวเลขยังเปลี่ยนได้, `patientDays` = ผู้ป่วยที่นอนอยู่ขณะนี้) · `true` = ปิดยอดแล้วโดย sync แรกหลังเที่ยงคืน ซึ่งคำนวณ `admitted`/`discharged`/`patientDays` ใหม่ทั้งวันจาก HOSxP และจะไม่เปลี่ยนอีก |
| `wardName`, `departmentCode`, `departmentName` | ชื่อหอ / แผนก ณ วันนั้น |

ข้อควรทราบ: ผู้ป่วยที่ย้ายหอจะถูกนับในหอปัจจุบัน/หอที่จำหน่าย (HOSxP `ipt.ward`)

## OPD: waiting to see a doctor (การรอคอยการพบแพทย์แต่ละแผนก)

Types: `src/lib/opd/types.ts` (`OpdBoard`, `ClinicWait`, `OpdHourPoint`,
`OpdDaily`). Source: PostgreSQL only (`wait.opd_*`), written by the OPD
sync worker `scripts/sync-opd.mjs` (cron every 5 min, 06:00–20:55
Asia/Bangkok). The web app never queries HOSxP. Aggregates only — no HN,
VN, names, queue numbers or doctor codes are stored or sent.

### Definitions (HOSxP, `scripts/lib/hosxp-opd.mjs`)

| term | definition |
| --- | --- |
| visit | `ovst` row of the day (`vstdate`), registration time = `vstdate + vsttime`. Visits registered at the ER (`main_dep = '011'`) are left out entirely (ER has its own triage, not an OPD queue). Cancelled visits are deleted from `ovst` by HOSxP, so they never appear. |
| doctor exam start | the earliest `ovst_service_time.service_begin_datetime` with `ovst_service_time_type_code = 'OPD-DOCTOR'` of the visit, at a **clinic** (below). `OPD-NEW-VISIT` = registration (≈ `vsttime`), `OPD-SCREEN` = screening / vital signs (ซักประวัติ), `OPD-DOCTOR` = the doctor-room screen was opened. |
| clinic (`clinicCode`) | a `kskdepartment.depcode` where doctor exams happen: any depcode with `OPD-DOCTOR` rows in the last 28 days, **minus** non-doctor points: `010` IPD, `011` ER, `027` physiotherapy, `020`/`061`/`062` screening points, `006` X-ray, `007` lab, `013` pharmacy, `014` cashier, `023` medical records, `060` insurance, `999` home. Name = `kskdepartment.department` without the leading `NNN-`. Staff can rename / hide / order clinics in `wait.opd_clinic_config` (SQL for now). |
| clinic of a seen visit | the depcode of its doctor exam start |
| clinic of a not-yet-seen visit | live: `cur_dep` when it is a *queue clinic* (a clinic some route points to); else the **route** of `cur_dep`, else the route of `main_dep`. Closed day: the route of `main_dep`. Route of a department = the clinic where most of its visits saw a doctor over the last 28 days, used only when it had ≥ 5 visits and ≥ 50 % of them saw a doctor (e.g. `061` general screening → `001`, `062` NCD screening → `047`, `020` psych screening → `064`, `032` → `030`). Departments whose visits mostly never see a doctor (lab-only `007`, dental `008`, eye `018`, …) have no route, so those visits are not "waiting for a doctor". |
| wait (seen) | doctor exam start − registration, minutes (negative → 0). Waits over 720 min (doctor screen opened on a later day) are left out of the averages. |
| waiting now (`waitingNow`) | visit of today with a clinic, no doctor exam start yet, not admitted (`ovst.an` empty), `cur_dep` not pharmacy `013` / cashier `014` / home `999` / IPD `010` / ER `011`, and registered at most **480 min** ago (older ones are treated as stale — the patient left or the doctor never opened the screen). |
| `waitingForDoctor` | of those: already screened (`OPD-SCREEN` row) or `cur_dep` is the clinic itself — waiting in front of the doctor room. |
| `longestWaitMinutes` | longest registration → now among `waitingNow` (0 when none) |
| `seenToday`, `avg/median/p90WaitMinutes` | visits whose doctor exam start is today, at this clinic; wait stats over those (null when none) |
| `seenLastHour` | doctor exam starts in the last 60 min |
| `doctorsActive` | distinct `ovst_service_time.doctor` with an `OPD-DOCTOR` row at this clinic in the last 60 min |
| `estimatedWaitMinutes` | rough wait of a patient arriving now: `ceil(waitingNow × 60 / seenLastHour)` = time to clear the current queue at the last hour's pace (all doctors of the clinic together), capped at 480. `null` when `seenLastHour = 0` (no doctor working right now — unknown). `0` when nobody waits and doctors are working. |

Typical values (verified on HOSxP 2026-10-29 … 2026-11-25): general OPD `001`
mean 140 min, NCD `047` mean 236 min (patients register from 06:00 for
fasting labs, doctors start about 09:00), PCU `030` mean 62 min — see the
report of the feature branch for the per-day numbers.

### `GET /api/opd/board` (public)

200 `OpdBoard`. `Cache-Control: public, max-age=30, stale-while-revalidate=60`;
memoised 10 s per process. All minute values are whole minutes (rounded).

```json
{
  "asOf": "2026-11-26T04:20:05.000Z",
  "stale": false,
  "date": "2026-11-26",
  "clinics": [
    {
      "clinicCode": "001", "clinicName": "ห้องตรวจโรคทั่วไป",
      "waitingNow": 18, "waitingForDoctor": 9, "longestWaitMinutes": 175,
      "seenToday": 76, "avgWaitMinutes": 121, "medianWaitMinutes": 110, "p90WaitMinutes": 190,
      "doctorsActive": 2, "seenLastHour": 14, "estimatedWaitMinutes": 78
    }
  ],
  "hourly": [ { "hour": 8, "arrived": 120, "seen": 0, "avgWaitMinutes": null } ],
  "totals": {
    "waitingNow": 60, "waitingForDoctor": 31, "seenToday": 290,
    "avgWaitMinutes": 130, "medianWaitMinutes": 115, "longestWaitMinutes": 290
  }
}
```
(example numbers are made up)

- `asOf`: finish time of the last successful OPD sync (ISO, UTC); `date`:
  the HOSxP day it describes (before the first run of the day this is
  yesterday — the UI should show it).
- `stale`: `true` when, between 06:15 and 20:30 Asia/Bangkok, the last OPD
  sync is older than 15 minutes, or at any time when it is older than 16 h.
- `clinics`: every visible clinic active in the last 28 days (zeros
  allowed), ordered by `opd_clinic_config.sort_order`, then by today's
  visits (most first), then code.
- `hourly`: hours 0–23 of `date` (all 24, zeros allowed), over visible
  clinics: `arrived` = registrations in that hour (visits with a clinic),
  `seen` = doctor exam starts in that hour, `avgWaitMinutes` = mean wait of
  those seen in that hour.
- `totals`: over visible clinics; `median` over all their seen visits
  (not a median of medians).
- 503 `SYNC_NOT_READY` before the first successful OPD sync,
  503 `WAIT_DB_NOT_CONFIGURED` without PostgreSQL.

### Central API: `GET /api/v1/opd/current`

Same auth / rate limit / audit as the other `/api/v1` endpoints.

```json
{ "hospcode": "11252", "asOf": "…", "stale": false, "date": "2026-11-26",
  "totals": { …OpdBoard.totals },
  "clinics": [ …ClinicWait ] }
```

### Central API: `GET /api/v1/opd/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`

At most 92 days (same validation as `/api/v1/census`).

```json
{
  "hospcode": "11252", "from": "2026-11-01", "to": "2026-11-30",
  "generatedAt": "…", "lastSyncAt": "…", "stale": false,
  "days": [
    { "date": "2026-11-25", "finalized": true, "visits": 520, "seen": 470,
      "avgWaitMinutes": 128, "medianWaitMinutes": 112, "p90WaitMinutes": 240, "within60Pct": 24.3 }
  ],
  "rows": [ …OpdDaily ]
}
```

`rows` (`OpdDaily`, one per date × clinic): `visits` = visits whose clinic
is this one (seen here, or routed here and never seen), `seen` = saw a
doctor here, wait stats over `seen` (waits > 720 min left out),
`within60Pct` = share of `seen` within 60 min of registration (1 decimal).
`days` = whole hospital per day, computed from all visits (median of all
waits, not of the clinic medians). `finalized`: `false` = today (changes
every 5 min) · `true` = recomputed for the whole day from HOSxP by the
first OPD sync of a later day, never changes again.
