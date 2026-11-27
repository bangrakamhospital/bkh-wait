/**
 * Post-login redirect target: internal path only (no scheme, host,
 * protocol-relative "//", backslashes or control characters; never /login,
 * /api/* or /auth/*). Falls back to `fallback`. Pure, client + server.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/refer"): string {
  if (!raw || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) {
    return fallback;
  }
  try {
    const base = "http://internal.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    if (url.pathname === "/login" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** /login link that returns to `path` afterwards. */
export function loginHref(path: string): string {
  return `/login?next=${encodeURIComponent(safeNextPath(path, "/"))}`;
}
