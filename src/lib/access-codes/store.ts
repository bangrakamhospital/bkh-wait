import "server-only";

import { auditAdmin } from "../auth/audit";
import { pgQuery, withPgTransaction } from "../db/pg";
import { generateAccessCode, generateAccessCodeId, hashAccessCode, normalizeAccessCode } from "./code";
import type { AccessCodeActor, AccessCodeStatus, AccessCodeView } from "./types";

/**
 * Access codes in PostgreSQL (wait.access_code, db/007_auth.sql). Lookup is
 * by HMAC (unique index): the HMAC key is not in the database, so the hash
 * column reveals nothing about the codes. Rows are never deleted.
 */

const ID_RE = /^ac-[A-Za-z0-9_-]{12}$/;
const MAX_ACTIVE = 500;

export function isValidAccessCodeId(id: string): boolean {
  return ID_RE.test(id);
}

export interface AccessCodeRecord {
  id: string;
  name: string;
  org: string;
  createdAt: string;
  createdBy: AccessCodeActor;
  expiresAt: string;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
  revokedBy: AccessCodeActor | null;
}

interface Row {
  id: string;
  name: string;
  org: string;
  created_at: string;
  created_by: string;
  created_by_name: string;
  expires_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_by_name: string | null;
}

const COLUMNS = `id, name, org, created_at, created_by, created_by_name, expires_at,
  last_used_at, use_count, revoked_at, revoked_by, revoked_by_name`;

function toRecord(r: Row): AccessCodeRecord {
  return {
    id: r.id,
    name: r.name,
    org: r.org,
    createdAt: r.created_at,
    createdBy: { sub: r.created_by, name: r.created_by_name },
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by ? { sub: r.revoked_by, name: r.revoked_by_name ?? "" } : null,
  };
}

export function accessCodeStatus(r: AccessCodeRecord, now = Date.now()): AccessCodeStatus {
  if (r.revokedAt) return "revoked";
  return Date.parse(r.expiresAt) <= now ? "expired" : "active";
}

export function toAccessCodeView(r: AccessCodeRecord, now = Date.now()): AccessCodeView {
  return { ...r, status: accessCodeStatus(r, now) };
}

/** Display / audit name of an outsider: "name (org)". */
export function accessCodeDisplayName(r: Pick<AccessCodeRecord, "name" | "org">): string {
  return r.org ? `${r.name} (${r.org})` : r.name;
}

export async function listAccessCodes(): Promise<AccessCodeRecord[]> {
  const rows = await pgQuery<Row>(`SELECT ${COLUMNS} FROM access_code ORDER BY created_at DESC, id LIMIT 1000`);
  return rows.map(toRecord);
}

export async function getAccessCode(id: string): Promise<AccessCodeRecord | null> {
  if (!ID_RE.test(id)) return null;
  const [row] = await pgQuery<Row>(`SELECT ${COLUMNS} FROM access_code WHERE id = $1`, [id]);
  return row ? toRecord(row) : null;
}

export type CreateAccessCodeResult =
  | { ok: true; record: AccessCodeRecord; plaintext: string }
  | { ok: false; error: "too_many" };

export interface AdminActor {
  /** Principal id (decided_by / created_by). */
  id: string;
  name: string;
  /** Audit actor string. */
  actor: string;
}

export async function createAccessCode(
  input: { name: string; org: string; expiresAt: string },
  actor: AdminActor,
): Promise<CreateAccessCodeResult> {
  return withPgTransaction<CreateAccessCodeResult>(async (tx) => {
    const [count] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM access_code WHERE revoked_at IS NULL AND expires_at > now()",
    );
    if ((count?.n ?? 0) >= MAX_ACTIVE) return { ok: false, error: "too_many" };
    // 80-bit codes / 72-bit ids: a collision is practically impossible; the
    // unique constraints would abort the transaction rather than reuse one.
    const plaintext = generateAccessCode();
    const hash = hashAccessCode(normalizeAccessCode(plaintext)!);
    const [row] = await tx.query<Row>(
      `INSERT INTO access_code (id, name, org, code_hash, created_by, created_by_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       RETURNING ${COLUMNS}`,
      [generateAccessCodeId(), input.name, input.org, hash, actor.id, actor.name, input.expiresAt],
    );
    const record = toRecord(row);
    await auditAdmin(tx, actor.actor, "access_code.create", "access_code", record.id, {
      name: record.name,
      org: record.org,
      expiresAt: record.expiresAt,
    });
    return { ok: true, record, plaintext };
  });
}

export type RevokeAccessCodeResult =
  | { ok: true; record: AccessCodeRecord; changed: boolean }
  | { ok: false; error: "not_found" };

export async function revokeAccessCode(id: string, actor: AdminActor): Promise<RevokeAccessCodeResult> {
  if (!ID_RE.test(id)) return { ok: false, error: "not_found" };
  return withPgTransaction<RevokeAccessCodeResult>(async (tx) => {
    const [cur] = await tx.query<Row>(`SELECT ${COLUMNS} FROM access_code WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur) return { ok: false, error: "not_found" };
    if (cur.revoked_at) return { ok: true, record: toRecord(cur), changed: false };
    const [row] = await tx.query<Row>(
      `UPDATE access_code SET revoked_at = now(), revoked_by = $2, revoked_by_name = $3
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, actor.id, actor.name],
    );
    const record = toRecord(row);
    await auditAdmin(tx, actor.actor, "access_code.revoke", "access_code", id, { name: record.name, org: record.org });
    return { ok: true, record, changed: true };
  });
}

export type VerifyAccessCodeResult =
  | { ok: true; record: AccessCodeRecord }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" | "revoked"; record: AccessCodeRecord };

/**
 * Login check: normalise + HMAC the typed code, look it up, check revoked /
 * expired. A successful login updates last_used_at / use_count.
 */
export async function verifyAccessCode(input: string): Promise<VerifyAccessCodeResult> {
  const normalized = normalizeAccessCode(input);
  // Hash anyway so malformed input costs the same as a wrong code.
  const hash = hashAccessCode(normalized ?? "0".repeat(16));
  if (normalized === null) return { ok: false, reason: "invalid" };
  return withPgTransaction<VerifyAccessCodeResult>(async (tx) => {
    const [cur] = await tx.query<Row>(`SELECT ${COLUMNS} FROM access_code WHERE code_hash = $1 FOR UPDATE`, [hash]);
    if (!cur) return { ok: false, reason: "invalid" };
    const record = toRecord(cur);
    const status = accessCodeStatus(record);
    if (status !== "active") return { ok: false, reason: status, record };
    const [row] = await tx.query<Row>(
      `UPDATE access_code SET last_used_at = now(), use_count = least(use_count, 2147483646) + 1
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [cur.id],
    );
    return { ok: true, record: toRecord(row) };
  });
}
