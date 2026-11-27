import "server-only";

/** Request helpers for auth code (route handlers and Auth.js callbacks). */

/**
 * Best-effort client IP for rate limiting / audit (X-Forwarded-For is set
 * by nginx; without a proxy it can be spoofed). Never used for authorization.
 */
export function clientIp(headers: Headers | null | undefined): string {
  const first = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (first || headers?.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

export interface RequestMeta {
  ip: string;
  userAgent: string;
}

export function requestMeta(headers: Headers | null | undefined): RequestMeta {
  const ua = headers?.get("user-agent") ?? "";
  return {
    ip: clientIp(headers),
    userAgent: ua.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200),
  };
}

/** Strip control chars / whitespace and limit length before writing to logs. */
export function logSafe(value: string, max = 64): string {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, "_").slice(0, max);
}

/** Trim, strip control characters, collapse whitespace, cap length. */
export function cleanField(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
