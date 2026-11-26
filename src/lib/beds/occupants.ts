import "server-only";

import { isWaitDbConfigured, withPgTransaction, WaitDbConfigError } from "@/lib/db/pg";
import { ApiError } from "@/lib/http";

import type { BedOccupant } from "./types";

/**
 * RESTRICTED: the patient (HN) on each bed of one ward, for logged-in
 * staff only (GET /api/beds/occupants). The app role cannot read
 * wait.bed_occupant; it calls wait.bed_occupants_for_ward(ward, actor)
 * (db/006, SECURITY DEFINER), which returns the rows AND appends an
 * audit_log row (actor, 'view_hn', ward, row count) in the same statement.
 *
 * Never cached (no memo, no Next cache): every view is a fresh, audited
 * read. Never log the result.
 */

export interface WardOccupants {
  wardCode: string;
  /** ISO time of the last successful bed sync (the data is as of then). */
  asOf: string;
  occupants: BedOccupant[];
}

export const WARD_CODE_RE = /^[0-9A-Za-z]{1,4}$/;

export async function getWardOccupants(wardCode: string, actor: string): Promise<WardOccupants> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  if (!WARD_CODE_RE.test(wardCode)) throw new ApiError(400, "VALIDATION", "ward ไม่ถูกต้อง");
  return withPgTransaction(async (tx) => {
    const [last] = await tx.query<{ finished_at: string }>(
      "SELECT finished_at FROM sync_run WHERE ok AND job = 'beds' ORDER BY finished_at DESC LIMIT 1",
    );
    if (!last) throw new ApiError(503, "SYNC_NOT_READY", "ยังไม่มีข้อมูลเตียงจากการซิงก์ HOSxP");
    // Only wards shown on the board (no audit row for unknown / hidden / virtual wards).
    const [ward] = await tx.query<{ ward_code: string }>(
      "SELECT ward_code FROM ward_catalog WHERE ward_code = $1 AND active AND visible AND NOT is_virtual",
      [wardCode],
    );
    if (!ward) throw new ApiError(404, "NOT_FOUND", "ไม่พบหอผู้ป่วยนี้");
    const rows = await tx.query<{
      bedno: string;
      bed_name: string;
      hn: string;
      admit_date: string;
      length_of_stay_days: number;
      spclty_name: string | null;
    }>(
      `SELECT bedno, bed_name, hn, admit_date, length_of_stay_days, spclty_name
         FROM bed_occupants_for_ward($1, $2)`,
      [wardCode, actor],
    );
    return {
      wardCode,
      asOf: last.finished_at,
      occupants: rows.map((r) => ({
        bedno: r.bedno,
        bedName: r.bed_name,
        hn: r.hn,
        admitDate: r.admit_date,
        lengthOfStayDays: r.length_of_stay_days,
        spcltyName: r.spclty_name,
      })),
    };
  });
}
