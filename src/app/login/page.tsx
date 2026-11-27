import type { Metadata } from "next";
import { connection } from "next/server";

import { LoginPanel } from "@/components/auth/LoginPanel";
import { accessCodeHashingReady } from "@/lib/access-codes/code";
import { loginErrorMessage } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";
import type { SessionInfo } from "@/lib/auth/roles";
import { getSession, sessionInfo } from "@/lib/auth/session";
import { isAuthConfigured } from "@/lib/auth/settings";
import { ssoProvider } from "@/lib/auth/sso";
import { hasUsersConfigured } from "@/lib/auth/users";
import { isWaitDbConfigured } from "@/lib/db/pg";

export const metadata: Metadata = {
  title: "เข้าสู่ระบบ | ระบบบริหารเตียงและการรอคอย โรงพยาบาลบางระกำ",
  robots: { index: false, follow: false },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Env decides which sign-in methods exist: read it per request.
  await connection();
  const q = await searchParams;
  // ?next= (this app) or ?callbackUrl= (Auth.js default), internal paths only.
  const next = safeNextPath(first(q.next) ?? first(q.callbackUrl));
  const error = first(q.error);
  const configured = isAuthConfigured();

  let current: SessionInfo | null = null;
  try {
    const s = await getSession();
    current = s ? sessionInfo(s) : null;
  } catch {
    current = null;
  }

  return (
    <div className="mx-auto max-w-md">
      <LoginPanel
        next={next}
        current={current}
        error={error ? loginErrorMessage(error, first(q.code)) : null}
        methods={{
          configured,
          sso: configured && ssoProvider() !== null,
          code: configured && accessCodeHashingReady() && isWaitDbConfigured(),
          local: configured && hasUsersConfigured(),
        }}
      />
    </div>
  );
}
