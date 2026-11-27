import type { Metadata } from "next";
import { connection } from "next/server";

import { AdminUsersClient } from "@/components/admin/AdminUsersClient";
import { AdminShell, loadAdminSession } from "@/components/admin/AdminShell";
import { getSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "จัดการผู้ใช้งาน | ระบบบริหารเตียงและการรอคอย โรงพยาบาลบางระกำ",
  robots: { index: false, follow: false },
};

export default async function Page() {
  await connection();
  const { session, storeError } = await loadAdminSession(getSession);
  return (
    <AdminShell active="users" session={session} storeError={storeError}>
      <AdminUsersClient />
    </AdminShell>
  );
}
