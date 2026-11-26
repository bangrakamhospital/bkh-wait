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
  | 429  | `RATE_LIMITED`            | central API: too many calls for this key / failed keys from this IP; `Retry-After` |
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
