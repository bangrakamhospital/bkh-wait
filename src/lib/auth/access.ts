import "server-only";

import { accessCodeDisplayName, accessCodeStatus, getAccessCode, isValidAccessCodeId } from "../access-codes/store";
import { getUser } from "../users/store";
import { isEnvAdmin } from "../users/policy";
import { cleanField, logSafe } from "./request";
import type { Role, SessionProvider } from "./roles";
import { findUser } from "./users";

/**
 * Current access of a session principal, read from env + PostgreSQL on
 * EVERY request (src/lib/auth/session.ts), so an approval revoked, a role
 * changed, a code revoked / expired or a WAIT_USERS entry removed applies
 * on the next request.
 *
 * Principal ids (session `username`, refer_back_request.created_by):
 *   sso    "sso:<OIDC sub>"      wait.app_user must be approved (AUTH_ADMIN_SUBS -> admin)
 *   code   "code:<access id>"    wait.access_code must be active -> role partner, ALWAYS
 *   local  "<WAIT_USERS name>"   entry must exist with the same password
 *                                fingerprint (bare name: compatible with
 *                                requests created before SSO)
 */

export const SSO_PREFIX = "sso:";
export const CODE_PREFIX = "code:";

export type Access =
  | {
      ok: true;
      role: Role;
      name: string;
      /** Identifies the person in audit_log / bed_occupants_for_ward (<= 64 chars). */
      actor: string;
      /** Provider ID sub (sso only). */
      sub: string | null;
      /** Access code expiry (code only). */
      expiresAt?: string;
    }
  | { ok: false; reason: "invalid_session" | "unknown_user" | "pending" | "rejected" | "inactive" | "store_error" };

const MAX_ACTOR = 64;

/** "<kind>:<id>:<name>" capped at 64 chars (the limit of bed_occupants_for_ward). */
function actorOf(base: string, name: string): string {
  const n = cleanField(name, MAX_ACTOR);
  return (n ? `${base}:${n}` : base).slice(0, MAX_ACTOR).trim();
}

let lastStoreErrorLog = 0;

/** One short line, at most once a minute, never row contents. */
export function logStoreError(err: unknown) {
  const now = Date.now();
  if (now - lastStoreErrorLog < 60_000) return;
  lastStoreErrorLog = now;
  console.error(`[auth] user store error: ${logSafe(err instanceof Error ? err.message : "unknown", 120)}`);
}

export async function resolveAccess(
  username: string,
  provider: SessionProvider,
  opts: { fingerprint?: string; name?: string } = {},
): Promise<Access> {
  if (!username) return { ok: false, reason: "invalid_session" };

  if (provider === "local") {
    const user = findUser(username);
    if (!user || user.username !== username || user.fingerprint !== opts.fingerprint) {
      return { ok: false, reason: "unknown_user" };
    }
    return { ok: true, role: user.role, name: user.username, actor: actorOf(`local:${user.username}`, ""), sub: null };
  }

  if (provider === "code") {
    if (!username.startsWith(CODE_PREFIX)) return { ok: false, reason: "invalid_session" };
    const id = username.slice(CODE_PREFIX.length);
    if (!isValidAccessCodeId(id)) return { ok: false, reason: "invalid_session" };
    try {
      const rec = await getAccessCode(id);
      if (!rec) return { ok: false, reason: "unknown_user" };
      if (accessCodeStatus(rec) !== "active") return { ok: false, reason: "inactive" };
      const name = accessCodeDisplayName(rec);
      // An outsider is a partner whatever else is stored.
      return { ok: true, role: "partner", name, actor: actorOf(`code:${rec.id}`, rec.name), sub: null, expiresAt: rec.expiresAt };
    } catch (err) {
      logStoreError(err);
      return { ok: false, reason: "store_error" };
    }
  }

  if (!username.startsWith(SSO_PREFIX)) return { ok: false, reason: "invalid_session" };
  const sub = username.slice(SSO_PREFIX.length);
  if (!sub) return { ok: false, reason: "invalid_session" };
  try {
    const user = await getUser(sub);
    const name = user?.name || opts.name || sub;
    // Long subs would leave no room for the name: use the row id instead.
    const base = sub.length <= 40 || !user ? `sso:${sub}` : `sso#${user.id}`;
    if (isEnvAdmin(sub)) return { ok: true, role: "admin", name, actor: actorOf(base, name), sub };
    if (!user) return { ok: false, reason: "unknown_user" };
    if (user.status === "pending") return { ok: false, reason: "pending" };
    if (user.status === "rejected") return { ok: false, reason: "rejected" };
    return { ok: true, role: user.role, name, actor: actorOf(base, name), sub };
  } catch (err) {
    logStoreError(err);
    return { ok: false, reason: "store_error" };
  }
}
