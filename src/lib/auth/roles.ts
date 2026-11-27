/**
 * Roles and session shapes shared by server and client (pure module).
 *
 *   admin    approved Provider ID admin (or WAIT_USERS role admin): all of
 *            staff + /admin/users, /admin/access-codes, /api/admin/*
 *   staff    approved Provider ID user or WAIT_USERS staff: refer queue,
 *            departments, bed HN (audited)
 *   partner  outsider: access code or WAIT_USERS partner. Boards, create /
 *            track / cancel own refer-back requests. NEVER sees HN.
 */

export const ROLES = ["admin", "staff", "partner"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that may see patient identifiers (HN) and change configuration. */
export const STAFF_ROLES: readonly Role[] = ["admin", "staff"];
/** Every signed-in role. */
export const ANY_ROLE: readonly Role[] = ROLES;

/**
 * How the session was created:
 *   sso    PLK Health ID / MOPH Provider ID (OIDC)
 *   code   per-person access code issued at /admin/access-codes
 *   local  WAIT_USERS username + password (backup / emergency accounts)
 */
export type SessionProvider = "sso" | "code" | "local";

export function isSessionProvider(v: unknown): v is SessionProvider {
  return v === "sso" || v === "code" || v === "local";
}

/** Body of GET /api/session. */
export interface SessionInfo {
  /** Stable principal id ("sso:<sub>", "code:<id>", or the WAIT_USERS name). */
  username: string;
  /** Display name. */
  name: string;
  role: Role;
  provider: SessionProvider;
  /** Access-code sessions only: code expiry (ISO 8601). */
  expiresAt?: string;
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "ผู้ดูแลระบบ",
  staff: "เจ้าหน้าที่โรงพยาบาลบางระกำ",
  partner: "บุคคลภายนอก / รพ.แม่ข่าย",
};

/** Window event: the session changed in this tab (e.g. logout), re-read it. */
export const SESSION_CHANGED_EVENT = "bkh-wait:session-changed";
