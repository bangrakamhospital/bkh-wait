import "server-only";

import { getSession, type Session } from "./auth/session";
import type { Role } from "./auth/users";
import { WaitDbConfigError, WaitDbError } from "./db/pg";

/**
 * Shared helpers for route handlers: JSON responses, the error contract
 * `{ error, code }` (docs/api.md), CSRF / content-type checks for writes
 * and session guards.
 */

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "TOO_MANY_ATTEMPTS"
  | "AUTH_NOT_CONFIGURED"
  | "WAIT_DB_NOT_CONFIGURED"
  | "SYNC_NOT_READY"
  | "API_NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "INTERNAL";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const NO_STORE = "private, no-store";

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE, ...headers },
  });
}

/** Maps any thrown value to the error contract. Never leaks internals. */
export function errorResponse(err: unknown, label: string): Response {
  if (err instanceof ApiError) {
    return json({ error: err.message, code: err.code }, err.status, err.headers);
  }
  if (err instanceof WaitDbConfigError) {
    return json(
      { error: "ยังไม่ได้ตั้งค่าฐานข้อมูลระบบรับกลับ (WAIT_DATABASE_URL)", code: "WAIT_DB_NOT_CONFIGURED" },
      503,
    );
  }
  if (err instanceof WaitDbError) {
    console.error(`[${label}] ${err.message}${err.constraint ? ` ${err.constraint}` : ""}`);
  } else {
    console.error(`[${label}] unexpected error (${err instanceof Error ? err.name : typeof err})`);
  }
  return json({ error: "เกิดข้อผิดพลาดภายในระบบ", code: "INTERNAL" }, 500);
}

export function validation(message: string): ApiError {
  return new ApiError(400, "VALIDATION", message);
}

/**
 * CSRF check for state-changing requests: Origin must be this host (nginx
 * forwards Host: $http_host) and Sec-Fetch-Site, when sent, same-origin.
 * Requests without Origin are refused (browsers send it on POST/PATCH/PUT).
 */
export function isSameOriginRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (!host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * For browser writes: same-origin + `Content-Type: application/json`, then
 * parse the body (max 16 KiB) as a JSON object.
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!isSameOriginRequest(request.headers)) {
    throw new ApiError(403, "FORBIDDEN", "คำขอไม่ได้มาจากหน้าเว็บของระบบ");
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "ต้องส่งข้อมูลแบบ application/json");
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw validation("ข้อมูลยาวเกินกำหนด");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw validation("รูปแบบ JSON ไม่ถูกต้อง");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validation("ข้อมูลต้องเป็น JSON object");
  }
  return body as Record<string, unknown>;
}

/** Throws 401 without a session, 403 when the role is not in `roles`. */
export async function requireSession(roles?: readonly Role[]): Promise<Session> {
  const session = await getSession();
  if (!session) throw new ApiError(401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบ");
  if (roles && !roles.includes(session.role)) {
    throw new ApiError(403, "FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้");
  }
  return session;
}

/**
 * Best-effort client IP for rate limiting only (X-Forwarded-For is set by
 * nginx; without a proxy it can be spoofed). Never used for authorization.
 */
export function clientIp(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (first || headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

/** Parses an optional integer query parameter within [min, max]. */
export function intParam(
  value: string | null,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  if (value === null || value === "") return def;
  if (!/^\d+$/.test(value)) throw validation(`${name} ต้องเป็นจำนวนเต็ม`);
  const n = Number(value);
  if (n < min || n > max) throw validation(`${name} ต้องอยู่ระหว่าง ${min}-${max}`);
  return n;
}
