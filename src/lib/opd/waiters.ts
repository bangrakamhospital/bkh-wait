import "server-only";

import { isWaitDbConfigured, withPgTransaction, WaitDbConfigError } from "@/lib/db/pg";
import { ApiError } from "@/lib/http";

import type { ClinicWaiters, OpdWaiterStage } from "./waiter-types";

/**
 * RESTRICTED: the OPD visits waiting now in one clinic, with HN, for
 * logged-in staff only (GET /api/opd/waiters). The app role cannot read
 * wait.opd_waiter; it calls wait.opd_waiters_for_clinic(clinic, actor)
 * (db/010, SECURITY DEFINER), which returns the rows AND appends an
 * audit_log row (actor, 'opd_waiter.view', clinic, row count) in the same
 * statement. Same pattern as src/lib/beds/occupants.ts.
 *
 * Never cached (no memo, no Next cache): every view is a fresh, audited
 * read. Never log the result.
 */

export const CLINIC_CODE_RE = /^[0-9A-Za-z]{1,3}$/;

interface Row {
  hn: string;
  queue_no: number | null;
  stage: OpdWaiterStage;
  stale: boolean;
  /** timestamptz arrive as ISO strings (src/lib/db/pg.ts) */
  registered_at: string;
  screened_at: string | null;
  minutes_since_registration: number;
  minutes_since_screening: number | null;
  cur_dep: string | null;
  cur_dep_name: string | null;
  lab_pending: boolean;
  xray_ordered: boolean;
}


export async function getClinicWaiters(clinicCode: string, actor: string): Promise<ClinicWaiters> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  if (!CLINIC_CODE_RE.test(clinicCode)) throw new ApiError(400, "VALIDATION", "clinic ไม่ถูกต้อง");
  return withPgTransaction(async (tx) => {
    const [last] = await tx.query<{ finished_at: string }>(
      "SELECT finished_at FROM sync_run WHERE ok AND job = 'opd' ORDER BY finished_at DESC LIMIT 1",
    );
    if (!last) throw new ApiError(503, "SYNC_NOT_READY", "ยังไม่มีข้อมูลการรอพบแพทย์จากการซิงก์ HOSxP");
    // Only clinics shown on the board (no audit row for unknown / hidden clinics).
    const [clinic] = await tx.query<{ clinic_name: string }>(
      "SELECT clinic_name FROM opd_clinic_catalog WHERE clinic_code = $1 AND visible",
      [clinicCode],
    );
    if (!clinic) throw new ApiError(404, "NOT_FOUND", "ไม่พบคลินิกนี้");
    const rows = await tx.query<Row>(
      `SELECT hn, queue_no, stage, stale, registered_at, screened_at, minutes_since_registration,
              minutes_since_screening, cur_dep, cur_dep_name, lab_pending, xray_ordered
         FROM opd_waiters_for_clinic($1, $2)`,
      [clinicCode, actor],
    );
    return {
      clinicCode,
      clinicName: clinic.clinic_name,
      asOf: last.finished_at,
      waiters: rows.map((r) => ({
        hn: r.hn,
        queueNo: r.queue_no,
        stage: r.stage,
        stale: r.stale,
        registeredAt: r.registered_at,
        screenedAt: r.screened_at,
        minutesSinceRegistration: r.minutes_since_registration,
        minutesSinceScreening: r.minutes_since_screening,
        curDep: r.cur_dep,
        curDepName: r.cur_dep_name,
        labPending: r.lab_pending,
        xrayOrdered: r.xray_ordered,
      })),
    };
  });
}
