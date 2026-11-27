import Link from "next/link";
import { KeyRound, LogIn, ShieldOff, Users } from "lucide-react";

import type { Session } from "@/lib/auth/session";
import { buttonClass, Card, ErrorState } from "../ui";

const tabCls = "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium";

/** Server-side gate + tabs of /admin/* (the APIs check the role again). */
export function AdminShell({
  active,
  session,
  storeError,
  children,
}: {
  active: "users" | "access-codes";
  session: Session | null;
  storeError: boolean;
  children: React.ReactNode;
}) {
  const path = active === "users" ? "/admin/users" : "/admin/access-codes";
  if (storeError) return <ErrorState message="ไม่สามารถตรวจสอบสิทธิ์ผู้ใช้ได้ในขณะนี้ กรุณาลองใหม่" />;
  if (!session) {
    return (
      <Card title="กรุณาเข้าสู่ระบบ">
        <div className="space-y-3 text-xs">
          <p>ต้องเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ</p>
          <Link href={`/login?next=${encodeURIComponent(path)}`} className={buttonClass}>
            <LogIn size={14} aria-hidden /> เข้าสู่ระบบ
          </Link>
        </div>
      </Card>
    );
  }
  if (session.role !== "admin") {
    return (
      <Card>
        <div className="space-y-2 text-xs">
          <p className="flex items-center gap-1 text-sm font-semibold text-red-700">
            <ShieldOff size={16} aria-hidden /> เฉพาะผู้ดูแลระบบ
          </p>
          <p>บัญชีของคุณไม่มีสิทธิ์เข้าหน้านี้</p>
          <Link href="/" className="text-brand-700 underline">
            กลับหน้าแรก
          </Link>
        </div>
      </Card>
    );
  }
  const tabs = [
    { key: "users", href: "/admin/users", label: "ผู้ใช้งาน (Provider ID)", Icon: Users },
    { key: "access-codes", href: "/admin/access-codes", label: "รหัสบุคคลภายนอก", Icon: KeyRound },
  ] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">จัดการระบบ</h1>
        <nav className="flex flex-wrap gap-2" aria-label="เมนูผู้ดูแลระบบ">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              aria-current={active === t.key ? "page" : undefined}
              className={`${tabCls} ${active === t.key ? "bg-brand-700 text-white" : "bg-brand-50 text-brand-800 hover:bg-brand-100"}`}
            >
              <t.Icon size={14} aria-hidden /> {t.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}

/** Session for an admin page: { session, storeError }. */
export async function loadAdminSession(get: () => Promise<Session | null>) {
  try {
    return { session: await get(), storeError: false };
  } catch {
    return { session: null, storeError: true };
  }
}
