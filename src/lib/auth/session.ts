import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { findUser, type Role } from "./users";

/**
 * Stateless session: httpOnly cookie `bkh_wait_session` =
 *   base64url(JSON {u, r, f, iat, exp}) "." base64url(HMAC-SHA256)
 * signed with WAIT_SESSION_SECRET (>= 32 chars; unset -> login disabled).
 *
 * A session is valid only while the account still exists in WAIT_USERS
 * with the same role and password-hash fingerprint, so removing a user or
 * changing their password revokes their sessions on the next request.
 * Rotating WAIT_SESSION_SECRET logs everybody out.
 *
 * Cookie flags: HttpOnly, SameSite=Lax, Path=/, Max-Age 12 h; Secure in
 * production unless WAIT_COOKIE_INSECURE=true (plain-HTTP intranet).
 */

export const SESSION_COOKIE = "bkh_wait_session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export interface Session {
  username: string;
  role: Role;
}

interface Payload {
  u: string;
  r: Role;
  f: string;
  iat: number;
  exp: number;
}

function secret(): string | null {
  const s = process.env.WAIT_SESSION_SECRET ?? "";
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

export function isAuthConfigured(): boolean {
  return secret() !== null;
}

export function secureCookies(): boolean {
  if (process.env.WAIT_COOKIE_INSECURE?.trim().toLowerCase() === "true") return false;
  return process.env.NODE_ENV === "production";
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

export function createSessionToken(
  user: { username: string; role: Role; fingerprint: string },
  now = Date.now(),
): string {
  const key = secret();
  if (!key) throw new Error("WAIT_SESSION_SECRET is not configured");
  const iat = Math.floor(now / 1000);
  const payload: Payload = {
    u: user.username,
    r: user.role,
    f: user.fingerprint,
    iat,
    exp: iat + SESSION_MAX_AGE_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

export function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): Session | null {
  const key = secret();
  if (!key || !token || token.length > 1024) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body, key));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
  const user = typeof p.u === "string" ? findUser(p.u) : null;
  if (!user || user.role !== p.r || user.fingerprint !== p.f) return null;
  return { username: user.username, role: user.role };
}

/** Current session from the request cookie (route handlers / server components). */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Sets the session cookie (route handlers / server functions only). */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 0,
  });
}
