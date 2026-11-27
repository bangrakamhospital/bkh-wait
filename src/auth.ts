import "server-only";

import NextAuth, { CredentialsSignin, type NextAuthConfig, type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { accessCodeHashingReady } from "@/lib/access-codes/code";
import { accessCodeDisplayName, verifyAccessCode } from "@/lib/access-codes/store";
import { ACCESS_CODE_INPUT_MAX } from "@/lib/access-codes/types";
import { CODE_PREFIX, logStoreError, resolveAccess, SSO_PREFIX } from "@/lib/auth/access";
import { auditAuth } from "@/lib/auth/audit";
import { LOGIN_CODE, rateLimitedCode, SSO_CODE } from "@/lib/auth/messages";
import {
  accessCodeRetryAfter,
  loginRetryAfter,
  recordAccessCodeFailure,
  recordAccessCodeSuccess,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/auth/rate-limit";
import { logSafe, requestMeta, type RequestMeta } from "@/lib/auth/request";
import { isSessionProvider, type SessionProvider } from "@/lib/auth/roles";
import { authSecret, secureCookies, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/settings";
import { checkOrg, ssoProvider, ssoUserInfo, warnOnRedirectOriginMismatch } from "@/lib/auth/sso";
import { ACCESS_CODE_PROVIDER_ID, LOCAL_PROVIDER_ID, SSO_PROVIDER_ID } from "@/lib/auth/sso-id";
import { verifyCredentials } from "@/lib/auth/users";
import { isBootstrapAdminName, isEnvAdmin } from "@/lib/users/policy";
import { recordSsoLogin } from "@/lib/users/store";

/**
 * Auth.js (next-auth v5) configuration — same design as bkh-kpi (:82).
 *
 *  Providers
 *   - "plkhealth"    PLK Health ID / MOPH Provider ID (OIDC, src/lib/auth/sso.ts),
 *                    only when AUTH_PLKHEALTH_* is complete. Org allow-list
 *                    (fail closed), then wait.app_user: new users are pending
 *                    until an admin approves them at /admin/users.
 *   - "access-code"  per-person code issued at /admin/access-codes -> role partner.
 *   - "local"        WAIT_USERS username + password (backup / emergency).
 *  Session
 *   - Stateless JWT in an encrypted cookie (AUTH_SECRET, or the older
 *     WAIT_SESSION_SECRET), absolute lifetime 8 h from login. Holds only
 *     { username (principal id), name, provider, loginAt, fp }.
 *   - Role and validity are NOT trusted from the cookie: getSession()
 *     (src/lib/auth/session.ts) re-reads env + PostgreSQL on every request.
 *   - Cookie names are app specific: bkh-kpi runs on the same host (:82)
 *     and browsers do not separate cookies by port.
 *  Routes: /api/auth/* (Auth.js), /auth/callback (IdP redirect URI), /login.
 *
 * Config is built per request (lazy init) so the client IP reaches the
 * audit log / rate limiter and env is read at request time.
 */

class LoginError extends CredentialsSignin {
  constructor(code: string) {
    super();
    this.code = code;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function requestOrigin(headers: Headers | null | undefined): string | null {
  const host = (headers?.get("x-forwarded-host") ?? headers?.get("host"))?.split(",")[0]?.trim();
  if (!host) return null;
  const proto =
    headers?.get("x-forwarded-proto")?.split(",")[0]?.trim() || (process.env.NODE_ENV === "production" ? "https" : "http");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

function sessionProviderOf(providerId: string | undefined): SessionProvider | null {
  if (providerId === SSO_PROVIDER_ID) return "sso";
  if (providerId === ACCESS_CODE_PROVIDER_ID) return "code";
  if (providerId === LOCAL_PROVIDER_ID) return "local";
  return null;
}

function cookieNames(secure: boolean) {
  const opts = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
  const p = secure ? "__Secure-" : "";
  return {
    sessionToken: { name: `${p}bkh-wait.session-token`, options: opts },
    callbackUrl: { name: `${p}bkh-wait.callback-url`, options: opts },
    csrfToken: { name: `${secure ? "__Host-" : ""}bkh-wait.csrf-token`, options: opts },
    pkceCodeVerifier: { name: `${p}bkh-wait.pkce.code_verifier`, options: { ...opts, maxAge: 900 } },
    state: { name: `${p}bkh-wait.state`, options: { ...opts, maxAge: 900 } },
    nonce: { name: `${p}bkh-wait.nonce`, options: opts },
  };
}

async function ssoAdmission(sub: string, profile: Record<string, unknown> | undefined, meta: RequestMeta): Promise<true | string> {
  const info = ssoUserInfo(profile);
  const who = `${SSO_PREFIX}${sub}`;
  let result;
  try {
    result = await recordSsoLogin(
      { sub, name: info.name, orgCode: info.orgCode, orgName: info.orgName, jobPosition: info.jobPosition },
      { envAdmin: isEnvAdmin(sub), bootstrapCandidate: isBootstrapAdminName(info.fname) },
    );
  } catch (err) {
    logStoreError(err);
    auditAuth("login_store_error", who, meta, { method: "sso", name: info.name });
    return `/login?error=AccessDenied&code=${SSO_CODE.userStoreUnavailable}`;
  }
  const { user, created, promoted } = result;
  if (created) auditAuth("user_created", who, meta, { method: "sso", name: info.name });
  if (promoted === "bootstrap") auditAuth("user_bootstrap_admin", who, meta, { method: "sso", name: info.name });
  if (promoted === "env") auditAuth("user_env_admin", who, meta, { method: "sso", name: info.name });
  if (user.status === "approved" || isEnvAdmin(sub)) {
    auditAuth("login_success", who, meta, { method: "sso", name: info.name });
    return true;
  }
  if (user.status === "rejected") {
    auditAuth("login_rejected", who, meta, { method: "sso", name: info.name });
    return `/login?error=AccessDenied&code=${SSO_CODE.rejected}`;
  }
  auditAuth("login_pending", who, meta, { method: "sso", name: info.name });
  return `/login?error=AccessDenied&code=${SSO_CODE.pending}`;
}

function localProvider(meta: RequestMeta) {
  return Credentials({
    id: LOCAL_PROVIDER_ID,
    name: "บัญชีสำรอง",
    credentials: { username: { label: "ชื่อผู้ใช้" }, password: { label: "รหัสผ่าน", type: "password" } },
    async authorize(credentials) {
      const username = typeof credentials?.username === "string" ? credentials.username.trim().slice(0, 64) : "";
      const password = typeof credentials?.password === "string" ? credentials.password : "";
      if (!username || !password || password.length > 256) throw new LoginError(LOGIN_CODE.missing);
      const retry = loginRetryAfter(meta.ip, username);
      if (retry > 0) {
        auditAuth("login_rate_limited", logSafe(username), meta, { method: "local" });
        throw new LoginError(rateLimitedCode(retry));
      }
      const user = await verifyCredentials(username, password);
      if (!user) {
        recordLoginFailure(meta.ip, username);
        auditAuth("login_failed", logSafe(username), meta, { method: "local" });
        return null;
      }
      recordLoginSuccess(meta.ip, username);
      auditAuth("login_success", user.username, meta, { method: "local" });
      // `email` carries the password-hash fingerprint into the jwt callback
      // (changing the password revokes the session); it never leaves the server.
      return { id: user.username, name: user.username, email: user.fingerprint };
    },
  });
}

function accessCodeProvider(meta: RequestMeta) {
  return Credentials({
    id: ACCESS_CODE_PROVIDER_ID,
    name: "รหัสสำหรับบุคคลภายนอก",
    credentials: { code: { label: "รหัส", type: "password" } },
    async authorize(credentials) {
      if (!accessCodeHashingReady()) throw new LoginError(LOGIN_CODE.disabled);
      const raw = credentials?.code;
      if (typeof raw !== "string" || raw.trim() === "" || raw.length > ACCESS_CODE_INPUT_MAX) {
        throw new LoginError(LOGIN_CODE.missing);
      }
      const retry = accessCodeRetryAfter(meta.ip);
      if (retry > 0) {
        auditAuth("login_rate_limited", "-", meta, { method: "code" });
        throw new LoginError(rateLimitedCode(retry));
      }
      let result;
      try {
        result = await verifyAccessCode(raw);
      } catch (err) {
        logStoreError(err);
        auditAuth("login_store_error", "-", meta, { method: "code" });
        throw new LoginError(LOGIN_CODE.unavailable);
      }
      if (!result.ok) {
        recordAccessCodeFailure(meta.ip);
        if (result.reason === "invalid") {
          auditAuth("login_failed", "-", meta, { method: "code", reason: "invalid" });
          throw new LoginError(LOGIN_CODE.accessCodeInvalid);
        }
        auditAuth("login_failed", `${CODE_PREFIX}${result.record.id}`, meta, {
          method: "code",
          name: accessCodeDisplayName(result.record),
          reason: result.reason,
        });
        throw new LoginError(LOGIN_CODE.accessCodeInactive);
      }
      recordAccessCodeSuccess(meta.ip);
      const username = `${CODE_PREFIX}${result.record.id}`;
      const name = accessCodeDisplayName(result.record);
      auditAuth("login_success", username, meta, { method: "code", name });
      return { id: username, name };
    },
  });
}

function buildConfig(meta: RequestMeta): NextAuthConfig {
  const sso = ssoProvider();
  const secure = secureCookies();
  return {
    secret: authSecret() ?? undefined,
    trustHost: true,
    useSecureCookies: secure,
    cookies: cookieNames(secure),
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/login", error: "/login" },
    providers: [...(sso ? [sso] : []), accessCodeProvider(meta), localProvider(meta)],
    callbacks: {
      async signIn({ account, profile }) {
        if (account?.provider !== SSO_PROVIDER_ID) return true;
        // Stable identity = OIDC `sub` (user.id is a random UUID per sign-in).
        const sub = str(account.providerAccountId);
        if (!sub || str(profile?.sub) !== sub || sub.length > 256) {
          auditAuth("login_failed", "-", meta, { method: "sso", reason: "invalid_profile" });
          return false;
        }
        const org = checkOrg(profile as Record<string, unknown> | undefined);
        if (org !== "allowed") {
          auditAuth("login_failed", `${SSO_PREFIX}${sub}`, meta, {
            method: "sso",
            name: ssoUserInfo(profile as Record<string, unknown> | undefined).name,
            reason: org,
          });
          return `/login?error=AccessDenied&code=${org === "not_configured" ? SSO_CODE.orgNotConfigured : SSO_CODE.orgNotAllowed}`;
        }
        return ssoAdmission(sub, profile as Record<string, unknown> | undefined, meta);
      },
      async jwt({ token, user, account }) {
        const now = Math.floor(Date.now() / 1000);
        if (user) {
          // Sign-in: fresh minimal token. Explicit mapping: an unknown
          // provider id never gets a session.
          const provider = sessionProviderOf(account?.provider);
          if (!provider) return null;
          const username = provider === "sso" ? `${SSO_PREFIX}${str(account?.providerAccountId)}` : str(user.id);
          if (!username || username === SSO_PREFIX) return null;
          if ((provider === "code") !== username.startsWith(CODE_PREFIX)) return null;
          const fp = provider === "local" ? str(user.email) : undefined;
          const access = await resolveAccess(username, provider, { fingerprint: fp, name: user.name ?? undefined });
          if (!access.ok) return null;
          return { sub: username, username, name: access.name, provider, loginAt: now, ...(fp ? { fp } : {}) };
        }
        // Absolute expiry: Auth.js re-issues the cookie on reads (rolling),
        // so enforce 8 h from login here. Store checks: getSession().
        const loginAt = typeof token.loginAt === "number" ? token.loginAt : 0;
        if (
          typeof token.username !== "string" ||
          !token.username ||
          !isSessionProvider(token.provider) ||
          loginAt > now + 60 ||
          now - loginAt >= SESSION_MAX_AGE_SECONDS
        ) {
          return null;
        }
        return token;
      },
      session({ token }) {
        const loginAt = typeof token.loginAt === "number" ? token.loginAt : 0;
        return {
          expires: new Date((loginAt + SESSION_MAX_AGE_SECONDS) * 1000).toISOString(),
          user: {
            username: typeof token.username === "string" ? token.username : "",
            name: typeof token.name === "string" ? token.name : "",
            provider: token.provider,
            loginAt,
            fp: typeof token.fp === "string" ? token.fp : undefined,
          },
        } as unknown as Session;
      },
    },
    events: {
      signOut(message) {
        const token = "token" in message ? message.token : null;
        const username = token && typeof token.username === "string" ? token.username : "";
        if (username && isSessionProvider(token?.provider)) {
          auditAuth("logout", username, meta, { method: token.provider });
        }
      },
    },
    logger: {
      // Short lines only: no stack traces, bodies or causes.
      error(error) {
        if (error instanceof CredentialsSignin) return;
        const type = (error as { type?: string }).type ?? error.name;
        console.error(`[auth][error] ${logSafe(String(type))}`);
      },
      warn(code) {
        console.warn(`[auth][warn] ${code}`);
      },
      debug() {},
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth((request) => {
  if (request?.nextUrl?.pathname.startsWith("/api/auth/signin/")) {
    warnOnRedirectOriginMismatch(requestOrigin(request.headers));
  }
  return buildConfig(requestMeta(request?.headers));
});
