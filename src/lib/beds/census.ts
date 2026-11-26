import "server-only";

import { isWaitDbConfigured, pgQuery, WaitDbConfigError } from "@/lib/db/pg";
import { validation } from "@/lib/http";

import type { DailyCensus } from "./types";

/** Daily census (wait.daily_census, written by scripts/sync-hosxp.mjs). */

export const MAX_CENSUS_DAYS = 92;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(v: string | null, field: string): Date {
  if (!v || !DATE_RE.test(v)) throw validation(`${field} ต้องเป็นวันที่รูปแบบ YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw validation(`${field} ไม่ใช่วันที่ที่มีอยู่จริง`);
  }
  return d;
}

/** Validates ?from&to: real dates, from <= to, at most 92 days inclusive. */
export function parseCensusRange(from: string | null, to: string | null): { from: string; to: string } {
  const f = parseDate(from, "from");
  const t = parseDate(to, "to");
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
  if (days < 1) throw validation("from ต้องไม่หลัง to");
  if (days > MAX_CENSUS_DAYS) throw validation(`ช่วงวันที่ต้องไม่เกิน ${MAX_CENSUS_DAYS} วัน`);
  return { from: from as string, to: to as string };
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** Rows of [from, to], ordered by date then ward sort order. */
export async function getDailyCensus(from: string, to: string): Promise<DailyCensus[]> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  const rows = await pgQuery<{
    census_date: string;
    ward_code: string;
    ward_name: string;
    department_code: string;
    department_name: string;
    beds: number;
    beds_in_use: number;
    peak_beds_in_use: number;
    admitted: number;
    discharged: number;
    patient_days: number;
    finalized: boolean;
    updated_at: string;
  }>(
    `SELECT d.census_date, d.ward_code, d.ward_name, d.department_code, d.department_name, d.beds,
            d.beds_in_use, d.peak_beds_in_use, d.admitted, d.discharged, d.patient_days,
            d.finalized_at IS NOT NULL AS finalized, d.updated_at
       FROM daily_census d
       LEFT JOIN ward_config c ON c.ward_code = d.ward_code
      WHERE d.census_date BETWEEN $1::date AND $2::date
      ORDER BY d.census_date, coalesce(c.sort_order, 1000), d.ward_code`,
    [from, to],
  );
  return rows.map((r) => {
    const available = Math.max(r.beds - r.beds_in_use, 0);
    return {
      date: r.census_date,
      wardCode: r.ward_code,
      wardName: r.ward_name,
      departmentCode: r.department_code,
      departmentName: r.department_name,
      beds: r.beds,
      bedsInUse: r.beds_in_use,
      available,
      occupancyPct: pct(r.beds - available, r.beds),
      peakBedsInUse: r.peak_beds_in_use,
      admitted: r.admitted,
      discharged: r.discharged,
      patientDays: r.patient_days,
      finalized: r.finalized,
      updatedAt: r.updated_at,
    };
  });
}

/** Finish time of the last successful sync, or null. */
export async function getLastSyncAt(): Promise<string | null> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  const [row] = await pgQuery<{ finished_at: string }>(
    "SELECT finished_at FROM sync_run WHERE ok AND job = 'beds' ORDER BY finished_at DESC LIMIT 1",
  );
  return row?.finished_at ?? null;
}
