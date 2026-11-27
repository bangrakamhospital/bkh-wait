"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { BadgeCheck, Loader2, LogIn, LogOut, Settings, UserCircle2 } from "lucide-react";

import { loginHref } from "@/lib/auth/redirect";
import { SESSION_CHANGED_EVENT, type SessionInfo } from "@/lib/auth/roles";

const pillClass =
  "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm text-white/90 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-60";
const iconCls = "h-4 w-4 shrink-0";

const dateFmt = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" });

/**
 * Who is signed in + logout, admin link for admins. Client-only (reads
 * GET /api/session, whose role is re-read from the user store), so pages
 * stay as they are. UI only: the server gates decide access.
 */
export function HeaderAuth() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/session", { cache: "no-store" })
        .then(async (r) => (r.ok ? ((await r.json()) as { user: SessionInfo | null }).user : null))
        .catch(() => null)
        .then((u) => {
          if (alive) setUser(u);
        });
    void load();
    window.addEventListener(SESSION_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(SESSION_CHANGED_EVENT, load);
    };
  }, [pathname]);

  if (user === undefined) return <span aria-hidden className="h-7 w-24 animate-pulse rounded-md bg-white/15" />;

  if (user === null) {
    if (pathname === "/login") return null;
    return (
      <Link href={loginHref(pathname)} className={pillClass}>
        <LogIn aria-hidden className={iconCls} /> เข้าสู่ระบบ
      </Link>
    );
  }

  const expiry = user.provider === "code" && user.expiresAt ? dateFmt.format(new Date(user.expiresAt)) : null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="inline-flex max-w-56 items-center gap-1 px-2 text-sm text-white/90">
        <UserCircle2 aria-hidden className={iconCls} />
        <span className="truncate" title={user.name}>
          {user.name}
        </span>
      </span>
      {user.role === "partner" ? (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-950"
          title="บัญชีบุคคลภายนอก: ดูกระดาน และสร้าง/ติดตามคำขอส่งกลับได้ ไม่เห็น HN"
        >
          <BadgeCheck aria-hidden className="h-3.5 w-3.5" />
          บุคคลภายนอก{expiry ? ` · ใช้ได้ถึง ${expiry}` : ""}
        </span>
      ) : null}
      {user.role === "admin" ? (
        <Link href="/admin/users" className={pillClass}>
          <Settings aria-hidden className={iconCls} /> จัดการระบบ
        </Link>
      ) : null}
      <button
        type="button"
        className={pillClass}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await signOut({ redirect: false }).catch(() => undefined);
          setUser(null);
          setBusy(false);
          window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
          router.push("/");
          router.refresh();
        }}
      >
        {busy ? <Loader2 aria-hidden className={`${iconCls} animate-spin`} /> : <LogOut aria-hidden className={iconCls} />}
        ออกจากระบบ
      </button>
    </div>
  );
}
