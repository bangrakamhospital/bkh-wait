import "server-only";

import { auditAdmin } from "../auth/audit";
import { cleanField } from "../auth/request";
import { pgQuery, withPgTransaction, type Queryable } from "../db/pg";
import type { AdminUserPatch, UserDecision, UserRole, UserStatus } from "./types";

/**
 * Provider ID accounts in PostgreSQL (wait.app_user, db/007_auth.sql).
 *
 *  - recordSsoLogin(): upsert on every SSO sign-in that passed the org
 *    allow-list (new = pending/staff), then apply the admin policy
 *    (AUTH_ADMIN_SUBS / AUTH_BOOTSTRAP_ADMIN_FNAMES).
 *  - updateUser(): admin decision, refuses own account, AUTH_ADMIN_SUBS
 *    accounts and removing the last approved admin.
 * Writes that depend on the number of admins take one advisory lock, so two
 * concurrent decisions cannot both pass the "last admin" check.
 */

export const MAX_SUB = 256;
const ADMIN_LOCK_KEY = 72_517_085; // arbitrary (db-migrate uses ..084)

export interface UserRecord {
  id: number;
  sub: string;
  name: string;
  orgCode: string;
  orgName: string;
  jobPosition: string;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string;
  loginCount: number;
  decidedBy: UserDecision | null;
  decidedAt: string | null;
}

interface UserRow {
  id: number;
  sub: string;
  name: string;
  org_code: string;
  org_name: string;
  job_position: string;
  status: UserStatus;
  role: UserRole;
  created_at: string;
  last_login_at: string;
  login_count: number;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
}

const COLUMNS = `id, sub, name, org_code, org_name, job_position, status, role, created_at,
  last_login_at, login_count, decided_by, decided_by_name, decided_at`;

function toRecord(r: UserRow): UserRecord {
  return {
    id: r.id,
    sub: r.sub,
    name: r.name,
    orgCode: r.org_code,
    orgName: r.org_name,
    jobPosition: r.job_position,
    status: r.status,
    role: r.role,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    loginCount: r.login_count,
    decidedBy: r.decided_by ? { sub: r.decided_by, name: r.decided_by_name ?? "" } : null,
    decidedAt: r.decided_at,
  };
}

export function isApprovedAdmin(u: Pick<UserRecord, "status" | "role">): boolean {
  return u.status === "approved" && u.role === "admin";
}

export async function getUser(sub: string): Promise<UserRecord | null> {
  if (!sub || sub.length > MAX_SUB) return null;
  const [row] = await pgQuery<UserRow>(`SELECT ${COLUMNS} FROM app_user WHERE sub = $1`, [sub]);
  return row ? toRecord(row) : null;
}

/** Pending first, then most recent sign-in first. */
export async function listUsers(): Promise<UserRecord[]> {
  const rows = await pgQuery<UserRow>(
    `SELECT ${COLUMNS} FROM app_user
      ORDER BY (status = 'pending') DESC, last_login_at DESC, id DESC
      LIMIT 5000`,
  );
  return rows.map(toRecord);
}

export interface SsoLoginInput {
  sub: string;
  name: string;
  orgCode: string;
  orgName: string;
  jobPosition: string;
}

export interface SsoLoginPolicy {
  /** sub is listed in AUTH_ADMIN_SUBS. */
  envAdmin: boolean;
  /** fname matches AUTH_BOOTSTRAP_ADMIN_FNAMES: promote only while no approved admin exists. */
  bootstrapCandidate: boolean;
}

export type Promotion = "env" | "bootstrap" | null;

export interface SsoLoginResult {
  user: UserRecord;
  created: boolean;
  promoted: Promotion;
}

async function approvedAdminCount(tx: Queryable): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app_user WHERE status = 'approved' AND role = 'admin'",
  );
  return row?.n ?? 0;
}

export async function recordSsoLogin(input: SsoLoginInput, policy: SsoLoginPolicy): Promise<SsoLoginResult> {
  const sub = input.sub;
  if (!sub || sub.length > MAX_SUB) throw new Error("invalid sub");
  return withPgTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK_KEY]);
    const [row] = await tx.query<UserRow & { created: boolean }>(
      `INSERT INTO app_user (sub, name, org_code, org_name, job_position, last_login_at, login_count)
       VALUES ($1, $2, $3, $4, $5, now(), 1)
       ON CONFLICT (sub) DO UPDATE
         SET name = coalesce(nullif(EXCLUDED.name, ''), app_user.name),
             org_code = EXCLUDED.org_code,
             org_name = EXCLUDED.org_name,
             job_position = EXCLUDED.job_position,
             last_login_at = now(),
             login_count = least(app_user.login_count, 2147483646) + 1
       RETURNING ${COLUMNS}, (xmax = 0) AS created`,
      [
        sub,
        cleanField(input.name) || sub.slice(0, 200),
        cleanField(input.orgCode, 32),
        cleanField(input.orgName),
        cleanField(input.jobPosition),
      ],
    );
    let user = toRecord(row);
    let promoted: Promotion = null;
    if (!isApprovedAdmin(user)) {
      if (policy.envAdmin) promoted = "env";
      else if (policy.bootstrapCandidate && (await approvedAdminCount(tx)) === 0) promoted = "bootstrap";
    }
    if (promoted) {
      const [up] = await tx.query<UserRow>(
        `UPDATE app_user
            SET status = 'approved', role = 'admin', decided_by = 'system', decided_by_name = $2, decided_at = now()
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [user.id, promoted === "env" ? "AUTH_ADMIN_SUBS" : "AUTH_BOOTSTRAP_ADMIN_FNAMES"],
      );
      user = toRecord(up);
    }
    return { user, created: row.created, promoted };
  });
}

export type UpdateUserResult =
  | { ok: true; user: UserRecord; changed: boolean; before: UserRecord }
  | { ok: false; error: "not_found" | "self" | "env_admin" | "last_admin" };

export async function updateUser(
  targetSub: string,
  patch: AdminUserPatch,
  actor: { id: string; name: string; actor: string; sub: string | null },
  isEnvAdmin: (sub: string) => boolean,
): Promise<UpdateUserResult> {
  if (!targetSub || targetSub.length > MAX_SUB) return { ok: false, error: "not_found" };
  return withPgTransaction<UpdateUserResult>(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK_KEY]);
    const [row] = await tx.query<UserRow>(`SELECT ${COLUMNS} FROM app_user WHERE sub = $1 FOR UPDATE`, [targetSub]);
    if (!row) return { ok: false, error: "not_found" };
    const before = toRecord(row);
    if (actor.sub !== null && before.sub === actor.sub) return { ok: false, error: "self" };
    if (isEnvAdmin(before.sub)) return { ok: false, error: "env_admin" };
    const status = patch.status ?? before.status;
    const role = patch.role ?? before.role;
    if (status === before.status && role === before.role) return { ok: true, user: before, changed: false, before };
    if (isApprovedAdmin(before) && !isApprovedAdmin({ status, role }) && (await approvedAdminCount(tx)) <= 1) {
      return { ok: false, error: "last_admin" };
    }
    const [up] = await tx.query<UserRow>(
      `UPDATE app_user
          SET status = $2, role = $3, decided_by = $4, decided_by_name = $5, decided_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [before.id, status, role, actor.id, cleanField(actor.name)],
    );
    const user = toRecord(up);
    await auditAdmin(tx, actor.actor, "user.update", "app_user", user.sub, {
      name: user.name,
      from: { status: before.status, role: before.role },
      to: { status: user.status, role: user.role },
    });
    return { ok: true, user, changed: true, before };
  });
}
