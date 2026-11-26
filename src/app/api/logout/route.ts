import { clearSessionCookie } from "@/lib/auth/session";
import { json } from "@/lib/http";

// Always succeeds. No CSRF check needed: the worst a cross-site request can
// do is log the user out (and SameSite=Lax keeps the cookie off it anyway).
export async function POST() {
  await clearSessionCookie();
  return json({ ok: true });
}
