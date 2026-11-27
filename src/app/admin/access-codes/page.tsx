import type { Metadata } from "next";
import { connection } from "next/server";

import { AdminAccessCodesClient } from "@/components/admin/AdminAccessCodesClient";
import { AdminShell, loadAdminSession } from "@/components/admin/AdminShell";
import { getSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "รหัสสำหรับบุคคลภายนอก | ระบบบริหารเตียงและการรอคอย โรงพยาบาลบางระกำ",
  robots: { index: false, follow: false },
};

export default async function Page() {
  await connection();
  const { session, storeError } = await loadAdminSession(getSession);
  return (
    <AdminShell active="access-codes" session={session} storeError={storeError}>
      <AdminAccessCodesClient />
    </AdminShell>
  );
}
