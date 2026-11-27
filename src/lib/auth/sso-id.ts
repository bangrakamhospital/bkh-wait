/**
 * Auth.js provider ids (pure constants, no "server-only"): shared by
 * src/auth.ts, the login page and the /auth/callback forwarder.
 */
export const SSO_PROVIDER_ID = "plkhealth";
export const ACCESS_CODE_PROVIDER_ID = "access-code";
export const LOCAL_PROVIDER_ID = "local";

/** Path registered at the IdP as redirect_uri (fixed by the IdP). */
export const SSO_REDIRECT_PATH = "/auth/callback";
