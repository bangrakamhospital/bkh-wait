import "server-only";

import type { Session } from "@/lib/auth/session";
import { isWaitDbConfigured, pgQuery, WaitDbConfigError, WaitDbError, withPgTransaction } from "@/lib/db/pg";
import { ApiError, validation } from "@/lib/http";

import { assertReferableWard } from "./config";
import type { ReferBackRequest, ReferStatus } from "./types";

/**
 * Refer-back requests (wait.refer_back_request). Status flow:
 *   waiting -> accepted -> admitted ; waiting|accepted -> cancelled
 * waitMinutes = requested_at -> admitted_at (admitted), -> cancelled_at
 * (cancelled), else -> now.
 */

export const REFER_STATUSES: readonly ReferStatus[] = ["waiting", "accepted", "admitted", "cancelled"];

const TRANSITIONS: Record<ReferStatus, readonly ReferStatus[]> = {
  waiting: ["accepted", "cancelled"],
  accepted: ["admitted", "cancelled"],
  admitted: [],
  cancelled: [],
};

export function canTransition(from: ReferStatus, to: ReferStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function requirePg(): void {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
}

const SELECT_COLUMNS = `
  id, case_ref, from_hospital, ward_code, diagnosis_note, status,
  requested_at, accepted_at, admitted_at, created_by,
  floor(extract(epoch FROM (coalesce(admitted_at, cancelled_at, now()) - requested_at)) / 60)::int AS wait_minutes`;

interface ReferRow {
  id: number;
  case_ref: string;
  from_hospital: string;
  ward_code: string | null;
  diagnosis_note: string;
  status: ReferStatus;
  requested_at: string;
  accepted_at: string | null;
  admitted_at: string | null;
  created_by: string;
  wait_minutes: number;
}

function toApi(r: ReferRow, viewer: string): ReferBackRequest {
  return {
    id: r.id,
    caseRef: r.case_ref,
    fromHospital: r.from_hospital,
    wardCode: r.ward_code,
    diagnosisNote: r.diagnosis_note,
    status: r.status,
    requestedAt: r.requested_at,
    acceptedAt: r.accepted_at,
    admittedAt: r.admitted_at,
    waitMinutes: Math.max(r.wait_minutes, 0),
    mine: r.created_by === viewer,
  };
}

export interface ListReferOptions {
  statuses?: readonly ReferStatus[];
  wardCode?: string | null;
  /** Requested within the last N days (default 30). */
  days?: number;
  limit?: number;
  /** Only requests created by this username (partner accounts). */
  createdBy?: string | null;
}

/** `viewer` = session username, used for `mine`. */
export async function listReferBack(viewer: string, opts: ListReferOptions = {}): Promise<ReferBackRequest[]> {
  requirePg();
  const statuses = opts.statuses && opts.statuses.length > 0 ? opts.statuses : REFER_STATUSES;
  const rows = await pgQuery<ReferRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM refer_back_request
      WHERE status = ANY($1::text[])
        AND ($2::text IS NULL OR ward_code = $2)
        AND requested_at >= now() - make_interval(days => $3)
        AND ($5::text IS NULL OR created_by = $5)
      ORDER BY requested_at DESC, id DESC
      LIMIT $4`,
    [statuses as string[], opts.wardCode ?? null, opts.days ?? 30, opts.limit ?? 200, opts.createdBy ?? null],
  );
  return rows.map((r) => toApi(r, viewer));
}

/** status='waiting' counts per ward ("" key = no ward). Empty map without PG. */
export async function countWaitingByWard(): Promise<Map<string, number>> {
  if (!isWaitDbConfigured()) return new Map();
  try {
    const rows = await pgQuery<{ ward_code: string | null; n: number }>(
      `SELECT ward_code, count(*)::int AS n FROM refer_back_request
        WHERE status = 'waiting' GROUP BY ward_code`,
    );
    return new Map(rows.map((r) => [r.ward_code ?? "", r.n]));
  } catch (err) {
    if (err instanceof WaitDbError || err instanceof WaitDbConfigError) {
      console.error(`[beds] refer counts unavailable: ${err.message}`);
      return new Map();
    }
    throw err;
  }
}

// --- validation --------------------------------------------------------------

// A Thai national ID is 13 digits, often written with dashes / spaces.
const NATIONAL_ID_RE = /\d{13}/;

function noIdentifiers(value: string, field: string): void {
  if (NATIONAL_ID_RE.test(value.replace(/[\s-]/g, ""))) {
    throw validation(`${field} ห้ามมีเลขประจำตัวประชาชน (ใช้รหัสอ้างอิงของ รพ.ต้นทางแทน)`);
  }
}

function text(v: unknown, field: string, min: number, max: number): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw validation(`${field} ต้องเป็นข้อความ`);
  // Strip control characters except newline / tab.
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length < min || s.length > max) {
    throw validation(min > 0 ? `${field} ต้องยาว ${min}-${max} ตัวอักษร` : `${field} ยาวได้ไม่เกิน ${max} ตัวอักษร`);
  }
  return s;
}

function wardCodeOf(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^[0-9A-Za-z]{1,4}$/.test(v)) throw validation("wardCode ไม่ถูกต้อง");
  return v;
}

export interface CreateReferInput {
  caseRef: unknown;
  fromHospital: unknown;
  wardCode?: unknown;
  diagnosisNote?: unknown;
}

export async function createReferBack(input: CreateReferInput, session: Session): Promise<ReferBackRequest> {
  requirePg();
  const caseRef = text(input.caseRef, "caseRef", 1, 60);
  const fromHospital = text(input.fromHospital, "fromHospital", 1, 120);
  const diagnosisNote = text(input.diagnosisNote, "diagnosisNote", 0, 500);
  const wardCode = wardCodeOf(input.wardCode);
  noIdentifiers(caseRef, "caseRef");
  noIdentifiers(fromHospital, "fromHospital");
  noIdentifiers(diagnosisNote, "diagnosisNote");
  if (wardCode) await assertReferableWard(wardCode);

  return withPgTransaction(async (tx) => {
    const [row] = await tx.query<ReferRow>(
      `INSERT INTO refer_back_request (case_ref, from_hospital, ward_code, diagnosis_note, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [caseRef, fromHospital, wardCode, diagnosisNote, session.username, session.actor],
    );
    await tx.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
       VALUES ($1, 'refer.create', 'refer_back_request', $2, $3::jsonb)`,
      [session.actor, String(row.id), JSON.stringify({ wardCode, fromHospital })],
    );
    return toApi(row, session.username);
  });
}

export interface UpdateReferInput {
  status: unknown;
  wardCode?: unknown;
}

export async function updateReferStatus(
  id: number,
  input: UpdateReferInput,
  session: Session,
): Promise<ReferBackRequest> {
  requirePg();
  if (typeof input.status !== "string" || !REFER_STATUSES.includes(input.status as ReferStatus)) {
    throw validation("status ต้องเป็น waiting, accepted, admitted หรือ cancelled");
  }
  const to = input.status as ReferStatus;
  const wardProvided = input.wardCode !== undefined;
  const newWard = wardCodeOf(input.wardCode);
  if (wardProvided && to !== "accepted") {
    throw validation("เปลี่ยน wardCode ได้พร้อมกับสถานะ accepted เท่านั้น");
  }
  if (session.role === "partner" && to !== "cancelled") {
    throw new ApiError(403, "FORBIDDEN", "บัญชี รพ.ต้นทางยกเลิกคำขอได้เท่านั้น");
  }
  if (newWard) await assertReferableWard(newWard);

  return withPgTransaction(async (tx) => {
    const [cur] = await tx.query<{ status: ReferStatus; created_by: string; ward_code: string | null }>(
      "SELECT status, created_by, ward_code FROM refer_back_request WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!cur) throw new ApiError(404, "NOT_FOUND", "ไม่พบคำขอนี้");
    if (session.role === "partner" && cur.created_by !== session.username) {
      throw new ApiError(403, "FORBIDDEN", "ยกเลิกได้เฉพาะคำขอที่บัญชีนี้สร้าง");
    }
    if (!canTransition(cur.status, to)) {
      throw new ApiError(409, "INVALID_TRANSITION", `เปลี่ยนสถานะจาก ${cur.status} เป็น ${to} ไม่ได้`);
    }
    const ward = wardProvided ? newWard : cur.ward_code;
    const [row] = await tx.query<ReferRow>(
      `UPDATE refer_back_request
          SET status = $2,
              ward_code = $3,
              accepted_at  = CASE WHEN $2 = 'accepted'  THEN now() ELSE accepted_at END,
              admitted_at  = CASE WHEN $2 = 'admitted'  THEN now() ELSE admitted_at END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
              updated_by = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id, to, ward, session.actor],
    );
    await tx.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
       VALUES ($1, 'refer.status', 'refer_back_request', $2, $3::jsonb)`,
      [session.actor, String(id), JSON.stringify({ from: cur.status, to, wardCode: ward })],
    );
    return toApi(row, session.username);
  });
}
