import "server-only";

import type { RowDataPacket } from "mysql2";

import { hisQuery } from "@/lib/db/his";

/**
 * HOSxP (read-only) queries behind the bed board. Aggregates only: no AN,
 * HN, names or bed numbers leave this module.
 *
 * Definitions (verified with db-cli on 2026-11-26):
 * - Active wards: `ward.ward_active = 'Y'` (01,02,03,04,16,17,18,19).
 * - Physical beds: COUNT(bedno JOIN roomno ON roomno) per roomno.ward —
 *   equals ward.bedcount for every active ward; ward.bedcount is the
 *   fallback when a ward has no bedno rows.
 * - Current inpatients: `ipt.dchdate IS NULL` AND
 *   `ipt.regdate >= CURDATE() - INTERVAL 180 DAY`. ipt.ward is the CURRENT
 *   ward (it is updated on transfer; matches the last iptbedmove.nward).
 *   Stale-admission cutoff: 10 never-discharged rows date from 2024-07 ..
 *   2025-01 with ward NULL (data-entry leftovers); real stays are far
 *   shorter — max LOS of 21,139 discharges in the last 2 years is 90 days,
 *   only 1 above 60. 180 days = 2x the longest real stay.
 * - Beds in use: COUNT(DISTINCT iptadm.bedno) of current inpatients whose
 *   bed belongs to their current ward (bedno -> roomno.ward = ipt.ward), so
 *   a bed left over from another ward after a transfer is not counted.
 *   bedno is unique, so the join adds no rows; iptadm has one row per AN. occupiedNoBed = patients - beds in
 *   use: no bed assigned, or several patients on one placeholder bed (ward
 *   17 Home Ward: 24 patients on bed HW01).
 * - Admitted / discharged today: ipt.regdate / ipt.dchdate = CURDATE()
 *   (DB clock is Asia/Bangkok, +07).
 * - Clinical department: ipt.spclty -> spclty.name.
 */

export const STALE_ADMISSION_DAYS = 180;

export interface HisWard {
  wardCode: string;
  wardName: string;
  /** Physical beds from bedno/roomno, else ward.bedcount. */
  beds: number;
}

export interface HisWardCensus {
  occupied: number;
  bedsInUse: number;
  admittedToday: number;
  dischargedToday: number;
}

export interface HisSpcltyCount {
  wardCode: string;
  spcltyCode: string;
  spcltyName: string;
  occupied: number;
}

interface WardRow extends RowDataPacket {
  ward_code: string;
  ward_name: string | null;
  bedcount: number | null;
  physical_beds: number;
}

export async function fetchActiveWards(): Promise<HisWard[]> {
  const rows = await hisQuery<WardRow>(
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
    beds: Number(r.physical_beds) > 0 ? Number(r.physical_beds) : Math.max(Number(r.bedcount ?? 0), 0),
  }));
}

interface CensusRow extends RowDataPacket {
  ward_code: string | null;
  occupied: number | string;
  beds_in_use: number | string;
  admitted_today: number | string;
  discharged_today: number | string;
}

export async function fetchWardCensus(): Promise<Map<string, HisWardCensus>> {
  const rows = await hisQuery<CensusRow>(
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
  const out = new Map<string, HisWardCensus>();
  for (const r of rows) {
    if (r.ward_code === null) continue;
    out.set(String(r.ward_code), {
      occupied: Number(r.occupied),
      bedsInUse: Number(r.beds_in_use),
      admittedToday: Number(r.admitted_today),
      dischargedToday: Number(r.discharged_today),
    });
  }
  return out;
}

interface SpcltyRow extends RowDataPacket {
  ward_code: string;
  spclty_code: string | null;
  spclty_name: string | null;
  occupied: number | string;
}

export async function fetchSpcltyCensus(): Promise<HisSpcltyCount[]> {
  const rows = await hisQuery<SpcltyRow>(
    `SELECT i.ward AS ward_code, i.spclty AS spclty_code, s.name AS spclty_name,
            COUNT(*) AS occupied
       FROM ipt i
       LEFT JOIN spclty s ON s.spclty = i.spclty
      WHERE i.dchdate IS NULL
        AND i.regdate >= CURDATE() - INTERVAL :staleDays DAY
        AND i.ward IS NOT NULL
      GROUP BY i.ward, i.spclty, s.name`,
    { staleDays: STALE_ADMISSION_DAYS },
  );
  return rows.map((r) => ({
    wardCode: String(r.ward_code),
    spcltyCode: r.spclty_code ?? "",
    spcltyName: (r.spclty_name ?? "").trim() || "ไม่ระบุ",
    occupied: Number(r.occupied),
  }));
}

interface DominantRow extends RowDataPacket {
  ward_code: string;
  spclty_code: string | null;
  spclty_name: string | null;
  n: number | string;
}

export interface DominantSpclty {
  spcltyCode: string;
  spcltyName: string;
}

const DOMINANT_TTL_MS = 6 * 60 * 60 * 1000;
const dominantStore = globalThis as unknown as {
  __waitDominant?: { at: number; map: Map<string, DominantSpclty> };
};

/**
 * Most frequent ipt.spclty per ward over the last 365 days — the fallback
 * department for wards without a ward_config.department_code. Cached 6 h.
 */
export async function fetchDominantSpclty(): Promise<Map<string, DominantSpclty>> {
  const cached = dominantStore.__waitDominant;
  if (cached && Date.now() - cached.at < DOMINANT_TTL_MS) return cached.map;
  const rows = await hisQuery<DominantRow>(
    `SELECT i.ward AS ward_code, i.spclty AS spclty_code, s.name AS spclty_name, COUNT(*) AS n
       FROM ipt i
       LEFT JOIN spclty s ON s.spclty = i.spclty
      WHERE i.regdate >= CURDATE() - INTERVAL 365 DAY
        AND i.ward IS NOT NULL AND i.spclty IS NOT NULL AND i.spclty <> ''
      GROUP BY i.ward, i.spclty, s.name`,
  );
  const best = new Map<string, { n: number; v: DominantSpclty }>();
  for (const r of rows) {
    const n = Number(r.n);
    const cur = best.get(r.ward_code);
    if (!cur || n > cur.n) {
      best.set(String(r.ward_code), {
        n,
        v: {
          spcltyCode: r.spclty_code ?? "",
          spcltyName: (r.spclty_name ?? "").trim() || `แผนก ${r.spclty_code}`,
        },
      });
    }
  }
  const map = new Map([...best].map(([k, { v }]) => [k, v]));
  dominantStore.__waitDominant = { at: Date.now(), map };
  return map;
}
