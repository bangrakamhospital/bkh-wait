"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Loader2, Search, ShieldCheck, ShieldOff, XCircle } from "lucide-react";

import type { AdminUser, AdminUsersResponse, UserRole, UserStatus } from "@/lib/users/types";
import { fmtDateTime, fmtNum } from "../format";
import { Card, EmptyState, ErrorState, LoadingState, buttonGhostClass, inputClass } from "../ui";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; users: AdminUser[]; meSub: string };
type Filter = "all" | UserStatus;

const STATUS_META: Record<UserStatus, { label: string; badge: string; Icon: typeof Clock }> = {
  pending: { label: "รออนุมัติ", badge: "bg-amber-100 text-amber-800", Icon: Clock },
  approved: { label: "อนุมัติแล้ว", badge: "bg-emerald-100 text-emerald-800", Icon: CheckCircle2 },
  rejected: { label: "ไม่อนุมัติ", badge: "bg-red-100 text-red-800", Icon: XCircle },
};

const btn = "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/** /admin/users: approve / reject Provider ID accounts, grant admin. */
export function AdminUsersClient() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState("");
  const [busySub, setBusySub] = useState<string | null>(null);
  const [confirmSub, setConfirmSub] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ sub: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      if (!res.ok) throw new Error(await errorOf(res, "โหลดข้อมูลผู้ใช้ไม่สำเร็จ"));
      const body = (await res.json()) as AdminUsersResponse;
      setState({ kind: "ready", users: body.users, meSub: body.me.sub });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "โหลดข้อมูลผู้ใช้ไม่สำเร็จ" });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const users = useMemo(() => (state.kind === "ready" ? state.users : []), [state]);
  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 };
    for (const u of users) c[u.status] += 1;
    return c;
  }, [users]);
  const activeFilter: Filter = filter ?? (counts.pending > 0 ? "pending" : "all");
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(
      (u) =>
        (activeFilter === "all" || u.status === activeFilter) &&
        (!q || [u.name, u.orgName, u.orgCode, u.jobPosition].some((v) => v.toLowerCase().includes(q))),
    );
  }, [users, activeFilter, query]);

  async function patch(sub: string, body: { status?: UserStatus; role?: UserRole }) {
    setBusySub(sub);
    setRowError(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(sub)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorOf(res, "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"));
      const { user } = (await res.json()) as { user: AdminUser };
      setState((s) => (s.kind === "ready" ? { ...s, users: s.users.map((u) => (u.sub === user.sub ? user : u)) } : s));
      setConfirmSub(null);
    } catch (e) {
      setRowError({ sub, message: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" });
    } finally {
      setBusySub(null);
    }
  }

  if (state.kind === "loading") return <LoadingState />;
  if (state.kind === "error") {
    return (
      <ErrorState
        message={state.message}
        action={
          <button type="button" className={buttonGhostClass} onClick={() => void load()}>
            ลองใหม่
          </button>
        }
      />
    );
  }

  function actions(u: AdminUser) {
    const busy = busySub === u.sub;
    if (state.kind === "ready" && u.sub === state.meSub) return <span className="text-xs text-slate-500">บัญชีของคุณ</span>;
    if (u.envAdmin) return <span className="text-xs text-slate-500">กำหนดใน AUTH_ADMIN_SUBS</span>;
    if (confirmSub === u.sub) {
      return (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs font-medium text-red-700">ยืนยันไม่อนุมัติ?</span>
          <button type="button" disabled={busy} className={`${btn} bg-red-600 text-white hover:bg-red-700`} onClick={() => void patch(u.sub, { status: "rejected" })}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <XCircle size={14} aria-hidden />} ยืนยัน
          </button>
          <button type="button" disabled={busy} className={`${btn} border border-slate-300 hover:bg-slate-100`} onClick={() => setConfirmSub(null)}>
            ยกเลิก
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-1">
        {u.status !== "approved" ? (
          <button type="button" disabled={busy} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => void patch(u.sub, { status: "approved" })}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />} อนุมัติ
          </button>
        ) : null}
        {u.status !== "rejected" ? (
          <button type="button" disabled={busy} className={`${btn} bg-red-600 text-white hover:bg-red-700`} onClick={() => setConfirmSub(u.sub)}>
            <XCircle size={14} aria-hidden /> ไม่อนุมัติ
          </button>
        ) : null}
        {u.status === "approved" ? (
          <button
            type="button"
            disabled={busy}
            className={`${btn} border border-violet-300 text-violet-800 hover:bg-violet-50`}
            onClick={() => void patch(u.sub, { role: u.role === "admin" ? "staff" : "admin" })}
          >
            {u.role === "admin" ? <ShieldOff size={14} aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
            {u.role === "admin" ? "ยกเลิกผู้ดูแล" : "ตั้งเป็นผู้ดูแล"}
          </button>
        ) : null}
      </div>
    );
  }

  function statusBadge(u: AdminUser) {
    const meta = STATUS_META[u.status];
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
          <meta.Icon size={12} aria-hidden /> {meta.label}
        </span>
        {u.role === "admin" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
            <ShieldCheck size={12} aria-hidden /> ผู้ดูแล
          </span>
        ) : null}
      </span>
    );
  }

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "pending", label: "รออนุมัติ", count: counts.pending },
    { key: "approved", label: "อนุมัติแล้ว", count: counts.approved },
    { key: "rejected", label: "ไม่อนุมัติ", count: counts.rejected },
    { key: "all", label: "ทั้งหมด", count: users.length },
  ];

  return (
    <Card title="ผู้ใช้งาน Provider ID">
      <div className="space-y-3">
        <p className="text-xs text-slate-600">
          ผู้ที่เข้าสู่ระบบด้วย Provider ID ครั้งแรกจะอยู่ในสถานะ &quot;รออนุมัติ&quot; และยังใช้งานไม่ได้จนกว่าผู้ดูแลระบบจะอนุมัติ การเปลี่ยนแปลงมีผลทันทีในคำขอถัดไปของผู้ใช้
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div role="tablist" aria-label="กรองตามสถานะ" className="flex flex-wrap gap-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeFilter === t.key}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  activeFilter === t.key ? "bg-brand-700 text-white" : "bg-brand-50 text-brand-800 hover:bg-brand-100"
                }`}
                onClick={() => setFilter(t.key)}
              >
                {t.label} ({fmtNum(t.count)})
              </button>
            ))}
          </div>
          <label className="relative block sm:w-64">
            <span className="sr-only">ค้นหาชื่อหรือหน่วยงาน</span>
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ค้นหาชื่อ / หน่วยงาน" className={`${inputClass} pl-7`} />
          </label>
        </div>

        {visible.length === 0 ? (
          <EmptyState message="ไม่พบผู้ใช้งาน" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-brand-50 text-brand-900">
                <tr>
                  <th className="px-2 py-2 font-semibold">ชื่อ</th>
                  <th className="px-2 py-2 font-semibold">หน่วยงาน / ตำแหน่ง</th>
                  <th className="px-2 py-2 font-semibold">สถานะ / สิทธิ์</th>
                  <th className="px-2 py-2 font-semibold">เข้าใช้ล่าสุด</th>
                  <th className="px-2 py-2 text-right font-semibold">ครั้ง</th>
                  <th className="px-2 py-2 font-semibold">ผู้อนุมัติ</th>
                  <th className="px-2 py-2 font-semibold">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {visible.map((u) => (
                  <tr key={u.sub} className="align-top">
                    <td className="px-2 py-2 font-medium">{u.name}</td>
                    <td className="px-2 py-2">
                      {u.orgName || "-"}
                      {u.orgCode ? <span className="block text-slate-500">{u.orgCode}</span> : null}
                      {u.jobPosition ? <span className="block text-slate-500">{u.jobPosition}</span> : null}
                    </td>
                    <td className="px-2 py-2">{statusBadge(u)}</td>
                    <td className="px-2 py-2">{fmtDateTime(u.lastLoginAt)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(u.loginCount)}</td>
                    <td className="px-2 py-2">
                      {u.decidedBy ? `${u.decidedBy.name || u.decidedBy.sub} / ${u.decidedAt ? fmtDateTime(u.decidedAt) : "-"}` : "-"}
                    </td>
                    <td className="px-2 py-2">
                      {actions(u)}
                      {rowError?.sub === u.sub ? (
                        <p role="alert" className="mt-1 text-red-700">
                          {rowError.message}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
