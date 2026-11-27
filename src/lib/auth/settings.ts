import "server-only";

/**
 * Auth settings read from env at request time (server only; values live
 * in .env, never in code — the repository is public).
 */

/** Absolute session lifetime: 8 hours from login (not extended by activity). */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const MIN_SECRET_LENGTH = 32;

/**
 * Key Auth.js encrypts the session cookie with: AUTH_SECRET, or the older
 * WAIT_SESSION_SECRET of installs from before SSO. < 32 chars -> null and
 * login is DISABLED (no default secret). Rotating it logs everybody out.
 */
export function authSecret(): string | null {
  for (const name of ["AUTH_SECRET", "WAIT_SESSION_SECRET"] as const) {
    const s = process.env[name] ?? "";
    if (s.length >= MIN_SECRET_LENGTH) return s;
  }
  return null;
}

export function isAuthConfigured(): boolean {
  return authSecret() !== null;
}

/**
 * Secure (and `__Secure-` / `__Host-` prefixed) cookies in production
 * (nginx terminates TLS on :84). AUTH_COOKIE_INSECURE=true (or the older
 * WAIT_COOKIE_INSECURE=true) turns this off for plain-HTTP setups.
 */
export function secureCookies(): boolean {
  for (const name of ["AUTH_COOKIE_INSECURE", "WAIT_COOKIE_INSECURE"] as const) {
    if (process.env[name]?.trim().toLowerCase() === "true") return false;
  }
  return process.env.NODE_ENV === "production";
}
