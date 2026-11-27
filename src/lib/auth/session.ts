import "server-only";

import { auth } from "@/auth";
import { resolveAccess } from "./access";
import { isSessionProvider, type Role, type SessionInfo, type SessionProvider } from "./roles";
import { isAuthConfigured } from "./settings";

/**
 * Current session for route handlers and server components.
 *
 * The Auth.js cookie (src/auth.ts) only proves WHO signed in and when; the
 * role and whether the session is still valid are re-read from env +
 * PostgreSQL here on every call (src/lib/auth/access.ts). So rejecting a
 * user, demoting an admin, revoking an access code or removing a WAIT_USERS
 * entry takes effect on the next request.
 *
 *   null                       not signed in / expired / no longer allowed
 *   throws SessionStoreUnavailable  user store unreadable (fail closed: 503)
 */

export interface Session {
  /** Stable principal id: "sso:<sub>", "code:<id>" or the WAIT_USERS name. */
  username: string;
  name: string;
  role: Role;
  provider: SessionProvider;
  /** Identifies the person in audit_log and bed_occupants_for_ward (<= 64 chars). */
  actor: string;
  /** Provider ID sub (sso sessions only). */
  sub: string | null;
  /** Access-code expiry (code sessions only). */
  expiresAt?: string;
}

export class SessionStoreUnavailable extends Error {
  override name = "SessionStoreUnavailable";
}

export { isAuthConfigured };

export async function getSession(): Promise<Session | null> {
  if (!isAuthConfigured()) return null;
  let raw: unknown;
  try {
    raw = (await auth())?.user;
  } catch {
    // Undecryptable / malformed cookie: treat as signed out.
    return null;
  }
  const u = raw as { username?: unknown; name?: unknown; provider?: unknown; fp?: unknown } | undefined;
  if (!u || typeof u.username !== "string" || !u.username || !isSessionProvider(u.provider)) return null;
  const access = await resolveAccess(u.username, u.provider, {
    fingerprint: typeof u.fp === "string" ? u.fp : undefined,
    name: typeof u.name === "string" ? u.name : undefined,
  });
  if (!access.ok) {
    if (access.reason === "store_error") throw new SessionStoreUnavailable("user store unavailable");
    return null;
  }
  return {
    username: u.username,
    name: access.name,
    role: access.role,
    provider: u.provider,
    actor: access.actor,
    sub: access.sub,
    ...(access.expiresAt ? { expiresAt: access.expiresAt } : {}),
  };
}

/** Client-safe view (GET /api/session). */
export function sessionInfo(s: Session): SessionInfo {
  return {
    username: s.username,
    name: s.name,
    role: s.role,
    provider: s.provider,
    ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
  };
}
