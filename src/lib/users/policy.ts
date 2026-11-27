import "server-only";

/**
 * Admin policy from env (server-only, comma separated, read per request):
 *   AUTH_ADMIN_SUBS              Provider ID `sub` values that are ALWAYS
 *                                approved admins (not changeable in the UI).
 *   AUTH_BOOTSTRAP_ADMIN_FNAMES  first names (exact match): such a user is
 *                                promoted to approved admin on SSO sign-in,
 *                                but only while no approved admin exists and
 *                                the org allow-list is not "*". Replace with
 *                                AUTH_ADMIN_SUBS after the first login.
 */

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.normalize("NFC").trim())
    .filter(Boolean);
}

export function isEnvAdmin(sub: string): boolean {
  return sub !== "" && list("AUTH_ADMIN_SUBS").includes(sub);
}

let warnedBootstrapAnyOrg = false;

export function isBootstrapAdminName(fname: string): boolean {
  const name = fname.normalize("NFC").trim();
  if (!name || !list("AUTH_BOOTSTRAP_ADMIN_FNAMES").includes(name)) return false;
  // "*" = any Provider ID account nationwide: a first name is far too weak.
  if (list("AUTH_PLKHEALTH_ALLOWED_ORGS").includes("*")) {
    if (!warnedBootstrapAnyOrg) {
      warnedBootstrapAnyOrg = true;
      console.warn('[auth] AUTH_BOOTSTRAP_ADMIN_FNAMES ignored: AUTH_PLKHEALTH_ALLOWED_ORGS is "*"; use AUTH_ADMIN_SUBS');
    }
    return false;
  }
  return true;
}
