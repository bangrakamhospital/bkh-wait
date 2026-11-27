import "server-only";

import { isWaitDbConfigured, pgQuery, type Queryable } from "../db/pg";
import { cleanField, type RequestMeta } from "./request";

/**
 * Sign-in audit trail in the append-only wait.audit_log (db/001):
 *   action  'auth.<event>'  (login_success, login_failed, login_pending, ...)
 *   actor   principal id ("sso:<sub>", "code:<id>", WAIT_USERS name) or "-"
 *   entity  'auth'
 *   detail  { method, name?, reason?, ip, ua }
 * Admin actions (user.*, access_code.*) are written by the stores inside
 * the same transaction as the change. No passwords, codes or tokens, ever.
 *
 * Best-effort: a failed insert is logged (one short line) and swallowed so
 * an audit outage cannot break sign-in; without PostgreSQL (WAIT_USERS-only
 * install) nothing is written.
 */

export type AuthEvent =
  | "login_success"
  | "login_failed"
  | "login_pending"
  | "login_rejected"
  | "login_rate_limited"
  | "login_store_error"
  | "user_created"
  | "user_env_admin"
  | "user_bootstrap_admin"
  | "logout";

export interface AuthAuditDetail {
  method: "sso" | "code" | "local";
  name?: string;
  reason?: string;
}

export function auditAuth(event: AuthEvent, actor: string, meta: RequestMeta, detail: AuthAuditDetail): void {
  if (!isWaitDbConfigured()) return;
  const body = {
    method: detail.method,
    ...(detail.name ? { name: cleanField(detail.name, 200) } : {}),
    ...(detail.reason ? { reason: cleanField(detail.reason, 60) } : {}),
    ip: meta.ip,
    ua: meta.userAgent,
  };
  pgQuery(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, 'auth', NULL, $3::jsonb)`,
    [cleanField(actor, 300) || "-", `auth.${event}`, JSON.stringify(body)],
  ).catch((err: unknown) => {
    console.error(`[auth] audit insert failed (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`);
  });
}

/** Admin action inside a store transaction (throws -> the change rolls back). */
export async function auditAdmin(
  tx: Queryable,
  actor: string,
  action: string,
  entity: "app_user" | "access_code",
  entityId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actor, action, entity, entityId, JSON.stringify(detail)],
  );
}
