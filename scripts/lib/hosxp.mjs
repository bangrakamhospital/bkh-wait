// HOSxP (MySQL/MariaDB, read-only) access for the sync worker
// (scripts/sync-hosxp.mjs). This is the ONLY place in bkh-wait that holds
// HOSxP SQL; the web app never connects to HOSxP — it reads the copies the
// worker writes to PostgreSQL. Aggregates only, with ONE exception:
// fetchBedOccupants() returns the HN per occupied bed, which the worker
// writes ONLY to the restricted table wait.bed_occupant (db/006; readable
// solely through the audited function wait.bed_occupants_for_ward). No AN,
// names or CID leave this module; HNs are never logged or printed.
//
// Definitions (verified with db-cli on 2026-11-26):
// - Active wards: `ward.ward_active = 'Y'`.
// - Physical beds: COUNT(bedno JOIN roomno ON roomno) per roomno.ward —
//   equals ward.bedcount for every active ward; ward.bedcount is the
//   fallback when a ward has no bedno rows.
// - Current inpatients: `ipt.dchdate IS NULL` AND
//   `ipt.regdate >= CURDATE() - INTERVAL 180 DAY`. ipt.ward is the CURRENT
//   ward (updated on transfer; matches the last iptbedmove.nward).
//   Stale-admission cutoff: a handful of never-discharged rows from
//   2024-07 .. 2025-01 with ward NULL are data-entry leftovers; the longest
//   real stay in two years is 90 days. 180 days = 2x the longest real stay.
// - Beds in use: COUNT(DISTINCT iptadm.bedno) of current inpatients whose
//   bed belongs to their current ward (bedno -> roomno.ward = ipt.ward), so
//   a bed left over from another ward after a transfer is not counted.
//   bedno is unique, so the join adds no rows; iptadm has one row per AN.
//   Patients without a bed of their own = patients - beds in use (no bed
//   assigned, or several patients on one placeholder bed, e.g. Home Ward).
// - Admitted / discharged on day D: ipt.regdate / ipt.dchdate = D
//   (DB clock is Asia/Bangkok, +07). Ward = ipt.ward (current / discharge
//   ward), so a patient transferred after admission counts in the new ward.
// - Patient days of day D (midnight census): admitted on or before D and
//   not discharged on or before D (dchdate IS NULL OR dchdate > D), same
//   180-day cutoff counted back from D.
// - Clinical department: ipt.spclty -> spclty.name.
// - Bed slots: every bedno of the ward (bedno JOIN roomno, roomno.ward),
//   ordered roomno, bed_order (NULLs last), bedno. bedno.bedname is empty
//   for every bed (checked 2026-11-26), so the bed name falls back to bedno.
// - Bed occupants: current inpatients (same 180-day cutoff) whose
//   iptadm.bedno belongs to their CURRENT ward (roomno.ward = ipt.ward) —
//   the same set as "beds in use". Patients without such a bed are only
//   counted (occupiedNoBed), never placed on a bed.

import mysql from "mysql2/promise";

export const STALE_ADMISSION_DAYS = 180;
const QUERY_TIMEOUT_MS = 30_000;
const ENV_KEYS = ["HIS_HOST", "HIS_PORT", "HIS_USER", "HIS_PASSWORD", "HIS_DATABASE"];

/** Thrown with a short code only; never carries host / user / password. */
export class SyncError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

function hisConfig() {
  const env = process.env;
  const missing = ENV_KEYS.filter((k) => !env[k]);
  // Variable NAMES only, never values.
  if (missing.length) throw new SyncError("HIS_NOT_CONFIGURED", `missing env: ${missing.join(", ")}`);
  const port = Number(env.HIS_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new SyncError("HIS_NOT_CONFIGURED", "HIS_PORT is invalid");
  return {
    host: env.HIS_HOST,
    port,
    user: env.HIS_USER,
    password: env.HIS_PASSWORD,
    database: env.HIS_DATABASE,
  };
}

/**
 * One read-only HOSxP connection (SET SESSION TRANSACTION READ ONLY before
 * anything else; the DB account should be SELECT-only as well).
 */
export async function openHis() {
  let conn;
  try {
    conn = await mysql.createConnection({
      ...hisConfig(),
      connectTimeout: 10_000,
      charset: "utf8mb4_unicode_ci",
      timezone: "+07:00",
      dateStrings: true,
      namedPlaceholders: true,
      multipleStatements: false,
      decimalNumbers: true,
    });
    await conn.query("SET SESSION TRANSACTION READ ONLY");
  } catch (err) {
    if (conn) conn.destroy();
    if (err instanceof SyncError) throw err;
    throw new SyncError(`HIS_${errCode(err)}`, "HOSxP connection failed");
  }
  return {
    async query(sql, params = {}) {
      try {
        const [rows] = await conn.execute({ sql, timeout: QUERY_TIMEOUT_MS }, params);
        return rows;
      } catch (err) {
        throw new SyncError(`HIS_${errCode(err)}`, "HOSxP query failed");
      }
    },
    async close() {
      await conn.end().catch(() => conn.destroy());
    },
  };
}

export function errCode(err) {
  const c = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  return /^[A-Z0-9_]{1,40}$/.test(c) ? c : "ERROR";
}

const num = (v) => Number(v ?? 0);

/** DB clock: today (YYYY-MM-DD, +07) and now. */
export async function fetchClock(his) {
  const [r] = await his.query("SELECT CURDATE() AS today, NOW() AS now");
  return { today: String(r.today), now: String(r.now) };
}

/** Active wards with physical beds (bedno/roomno), else ward.bedcount. */
export async function fetchActiveWards(his) {
  const rows = await his.query(
    `SELECT w.ward AS ward_code, w.name AS ward_name, w.bedcount,
            (SELECT COUNT(*) FROM bedno b JOIN roomno r ON r.roomno = b.roomno
              WHERE r.ward = w.ward) AS physical_beds
       FROM ward w
      WHERE w.ward_active = 'Y'
      ORDER BY w.ward`,
  );
  return rows.map((r) => ({
    wardCode: String(r.ward_code),
    wardName: (r.ward_name ?? "").trim() || `Ward ${r.ward_code}`,
    beds: num(r.physical_beds) > 0 ? num(r.physical_beds) : Math.max(num(r.bedcount), 0),
  }));
}

/** All clinical departments (spclty code -> name). */
export async function fetchSpclty(his) {
  const rows = await his.query("SELECT spclty AS code, name FROM spclty ORDER BY spclty");
  return rows
    .filter((r) => r.code !== null && String(r.code).trim() !== "")
    .map((r) => ({ code: String(r.code), name: (r.name ?? "").trim() || `แผนก ${r.code}` }));
}

/** Current census per ward (right now). */
export async function fetchWardCensus(his) {
  const rows = await his.query(
    `SELECT i.ward AS ward_code,
            SUM(i.dchdate IS NULL) AS occupied,
            COUNT(DISTINCT CASE WHEN i.dchdate IS NULL AND r.ward = i.ward THEN a.bedno END) AS beds_in_use,
            COALESCE(SUM(i.regdate = CURDATE()), 0) AS admitted_today,
            COALESCE(SUM(i.dchdate <=> CURDATE()), 0) AS discharged_today
       FROM ipt i
       LEFT JOIN iptadm a ON a.an = i.an
       LEFT JOIN bedno b ON b.bedno = a.bedno
       LEFT JOIN roomno r ON r.roomno = b.roomno
      WHERE i.regdate >= CURDATE() - INTERVAL :staleDays DAY
        AND (i.dchdate IS NULL OR i.dchdate = CURDATE() OR i.regdate = CURDATE())
        AND i.ward IS NOT NULL
      GROUP BY i.ward`,
    { staleDays: STALE_ADMISSION_DAYS },
  );
  const out = new Map();
  for (const r of rows) {
    if (r.ward_code === null) continue;
    const occupied = num(r.occupied);
    out.set(String(r.ward_code), {
      occupied,
      // never more beds in use than patients
      bedsInUse: Math.min(num(r.beds_in_use), occupied),
      admittedToday: num(r.admitted_today),
      dischargedToday: num(r.discharged_today),
    });
  }
  return out;
}

/** Current patients per ward x spclty. */
export async function fetchSpcltyCensus(his) {
  const rows = await his.query(
    `SELECT i.ward AS ward_code, i.spclty AS spclty_code, COUNT(*) AS occupied
       FROM ipt i
      WHERE i.dchdate IS NULL
        AND i.regdate >= CURDATE() - INTERVAL :staleDays DAY
        AND i.ward IS NOT NULL
      GROUP BY i.ward, i.spclty`,
    { staleDays: STALE_ADMISSION_DAYS },
  );
  return rows.map((r) => ({
    wardCode: String(r.ward_code),
    // "" = no spclty recorded (shown as "ไม่ระบุ")
    spcltyCode: r.spclty_code === null ? "" : String(r.spclty_code),
    occupied: num(r.occupied),
  }));
}

/**
 * Admitted / discharged / patient days (midnight census) of day `date`
 * (YYYY-MM-DD) per ward. Date-based, so it can be re-run for a past day.
 */
export async function fetchDayStats(his, date) {
  const rows = await his.query(
    `SELECT i.ward AS ward_code,
            SUM(i.regdate = :d) AS admitted,
            SUM(i.dchdate <=> :d) AS discharged,
            SUM(i.dchdate IS NULL OR i.dchdate > :d) AS patient_days
       FROM ipt i
      WHERE i.ward IS NOT NULL
        AND i.regdate BETWEEN DATE_SUB(:d, INTERVAL :staleDays DAY) AND :d
        AND (i.dchdate IS NULL OR i.dchdate >= :d)
      GROUP BY i.ward`,
    { d: date, staleDays: STALE_ADMISSION_DAYS },
  );
  const out = new Map();
  for (const r of rows) {
    out.set(String(r.ward_code), {
      admitted: num(r.admitted),
      discharged: num(r.discharged),
      patientDays: num(r.patient_days),
    });
  }
  return out;
}

/**
 * Most frequent ipt.spclty per ward over the last 365 days — the fallback
 * department of wards without a ward_config row.
 */
export async function fetchDominantSpclty(his) {
  const rows = await his.query(
    `SELECT i.ward AS ward_code, i.spclty AS spclty_code, COUNT(*) AS n
       FROM ipt i
      WHERE i.regdate >= CURDATE() - INTERVAL 365 DAY
        AND i.ward IS NOT NULL AND i.spclty IS NOT NULL AND i.spclty <> ''
      GROUP BY i.ward, i.spclty`,
  );
  const best = new Map();
  for (const r of rows) {
    const n = num(r.n);
    const cur = best.get(String(r.ward_code));
    if (!cur || n > cur.n) best.set(String(r.ward_code), { n, spcltyCode: String(r.spclty_code) });
  }
  return new Map([...best].map(([k, v]) => [k, v.spcltyCode]));
}

/**
 * Physical beds of the active wards, in HOSxP order (public: no patient
 * data). Callers drop virtual wards.
 */
export async function fetchBedSlots(his) {
  const rows = await his.query(
    `SELECT r.ward AS ward_code, b.bedno, b.bedname, b.roomno, r.name AS room_name
       FROM bedno b
       JOIN roomno r ON r.roomno = b.roomno
       JOIN ward w ON w.ward = r.ward AND w.ward_active = 'Y'
      ORDER BY r.ward, r.roomno, b.bed_order IS NULL, b.bed_order, b.bedno`,
  );
  return rows
    .filter((r) => r.bedno !== null && String(r.bedno).trim() !== "")
    .map((r) => {
      const bedno = String(r.bedno).trim();
      return {
        wardCode: String(r.ward_code),
        bedno,
        bedName: (r.bedname ?? "").trim() || bedno,
        roomNo: r.roomno === null ? null : String(r.roomno),
        roomName: (r.room_name ?? "").trim() || null,
      };
    });
}

/**
 * RESTRICTED: current inpatient per bed (ward, bedno, HN, admit date,
 * spclty). Only for wait.bed_occupant; never log or print the result.
 * One row per AN (iptadm has one row per AN).
 */
export async function fetchBedOccupants(his) {
  const rows = await his.query(
    `SELECT i.ward AS ward_code, a.bedno, i.hn, i.regdate, i.spclty AS spclty_code
       FROM ipt i
       JOIN iptadm a ON a.an = i.an
       JOIN bedno b ON b.bedno = a.bedno
       JOIN roomno r ON r.roomno = b.roomno
      WHERE i.dchdate IS NULL
        AND i.regdate >= CURDATE() - INTERVAL :staleDays DAY
        AND i.ward IS NOT NULL
        AND r.ward = i.ward
        AND i.hn IS NOT NULL AND i.hn <> ''`,
    { staleDays: STALE_ADMISSION_DAYS },
  );
  return rows.map((r) => ({
    wardCode: String(r.ward_code),
    bedno: String(r.bedno).trim(),
    hn: String(r.hn).trim(),
    admitDate: String(r.regdate).slice(0, 10),
    spcltyCode: r.spclty_code === null || String(r.spclty_code).trim() === "" ? null : String(r.spclty_code),
  }));
}
