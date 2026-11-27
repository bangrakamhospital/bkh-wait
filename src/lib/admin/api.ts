import "server-only";

import { hitRequestLimit } from "../auth/rate-limit";
import type { Session } from "../auth/session";
import { ApiError, isSameOriginRequest, requireAdmin } from "../http";
import { isEnvAdmin } from "../users/policy";
import type { UserRecord } from "../users/store";
import type { AdminUser } from "../users/types";

/**
 * Shared gate of /api/admin/*: current role admin (re-read per request),
 * 120 requests / admin / minute, and for writes the same-origin check
 * (readJsonBody does it for bodies; DELETE calls assertSameOriginWrite).
 */

const RATE_MAX = 120;
const RATE_WINDOW_MS = 60_000;

export async function adminGate(): Promise<Session> {
  const admin = await requireAdmin();
  const retry = hitRequestLimit(`admin|${admin.username}`, RATE_MAX, RATE_WINDOW_MS);
  if (retry > 0) {
    throw new ApiError(429, "RATE_LIMITED", "เรียกใช้งานถี่เกินไป กรุณาลองใหม่ภายหลัง", { "Retry-After": String(retry) });
  }
  return admin;
}

export function assertSameOriginWrite(headers: Headers): void {
  if (!isSameOriginRequest(headers)) throw new ApiError(403, "FORBIDDEN", "คำขอไม่ได้มาจากหน้าเว็บของระบบ");
}

/** Admin identity for decided_by / created_by columns and the audit actor. */
export function adminActor(admin: Session) {
  return { id: admin.username, name: admin.name, actor: admin.actor, sub: admin.sub };
}

/** API shape of a stored user. AUTH_ADMIN_SUBS accounts show as approved admins. */
export function toAdminUser(u: UserRecord): AdminUser {
  const env = isEnvAdmin(u.sub);
  return {
    sub: u.sub,
    name: u.name,
    orgCode: u.orgCode,
    orgName: u.orgName,
    jobPosition: u.jobPosition,
    status: env ? "approved" : u.status,
    role: env ? "admin" : u.role,
    envAdmin: env,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    loginCount: u.loginCount,
    decidedBy: u.decidedBy,
    decidedAt: u.decidedAt,
  };
}
