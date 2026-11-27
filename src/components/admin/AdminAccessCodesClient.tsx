"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Check, Copy, KeyRound, Loader2, Plus } from "lucide-react";

import {
  ACCESS_CODE_DEFAULT_DAYS,
  ACCESS_CODE_MAX_DAYS,
  ACCESS_CODE_NAME_MAX,
  ACCESS_CODE_ORG_MAX,
  addDays,
  bangkokToday,
  type AccessCodeCreateResponse,
  type AccessCodeStatus,
  type AccessCodeView,
} from "@/lib/access-codes/types";
import { fmtDateTime, fmtNum, type Tone } from "../format";
import { Badge, Card, EmptyState, ErrorState, LoadingState, buttonClass, buttonGhostClass, inputClass } from "../ui";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; codes: AccessCodeView[] };

const STATUS: Record<AccessCodeStatus, { label: string; tone: Tone }> = {
  active: { label: "ใช้งานได้", tone: "green" },
  expired: { label: "หมดอายุ", tone: "slate" },
  revoked: { label: "ยกเลิกแล้ว", tone: "red" },
};

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/**
 * /admin/access-codes: issue per-person codes for outsiders (role partner:
 * boards + own refer-back requests, never HN). The plaintext is shown once.
 */
export function AdminAccessCodesClient() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const today = bangkokToday();
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [expiresOn, setExpiresOn] = useState(() => addDays(bangkokToday(), ACCESS_CODE_DEFAULT_DAYS));
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<AccessCodeCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/access-codes", { cache: "no-store" });
      if (!res.ok) throw new Error(await errorOf(res, "โหลดรายการรหัสไม่สำเร็จ"));
      setState({ kind: "ready", codes: ((await res.json()) as { codes: AccessCodeView[] }).codes });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "โหลดรายการรหัสไม่สำเร็จ" });
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

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setFormError(null);
    setIssued(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/access-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, org, expiresOn }),
      });
      if (!res.ok) throw new Error(await errorOf(res, "สร้างรหัสไม่สำเร็จ"));
      const body = (await res.json()) as AccessCodeCreateResponse;
      setIssued(body);
      setName("");
      setOrg("");
      setState((s) => (s.kind === "ready" ? { ...s, codes: [body.code, ...s.codes] } : s));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "สร้างรหัสไม่สำเร็จ");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setBusyId(id);
    setRowError(null);
    try {
      const res = await fetch(`/api/admin/access-codes/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorOf(res, "ยกเลิกรหัสไม่สำเร็จ"));
      const { code } = (await res.json()) as { code: AccessCodeView };
      setState((s) => (s.kind === "ready" ? { ...s, codes: s.codes.map((c) => (c.id === code.id ? code : c)) } : s));
      setConfirmId(null);
    } catch (err) {
      setRowError({ id, message: err instanceof Error ? err.message : "ยกเลิกรหัสไม่สำเร็จ" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="ออกรหัสสำหรับบุคคลภายนอก">
        <form onSubmit={create} className="space-y-3">
          <p className="text-xs text-slate-600">
            หนึ่งรหัสต่อหนึ่งคน ผู้ใช้รหัสดูกระดานเตียง และสร้าง/ติดตามคำขอส่งกลับของตนเองได้ แต่จะไม่เห็น HN ผู้ป่วย ระบบเก็บเฉพาะค่า HMAC ของรหัส
            และแสดงรหัสเพียงครั้งเดียวหลังสร้าง
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-600">ชื่อ-สกุล</span>
              <input className={inputClass} value={name} maxLength={ACCESS_CODE_NAME_MAX} required onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-600">หน่วยงาน</span>
              <input className={inputClass} value={org} maxLength={ACCESS_CODE_ORG_MAX} required onChange={(e) => setOrg(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-600">ใช้ได้ถึงวันที่ (สูงสุด {ACCESS_CODE_MAX_DAYS} วัน)</span>
              <input
                className={inputClass}
                type="date"
                value={expiresOn}
                min={today}
                max={addDays(today, ACCESS_CODE_MAX_DAYS)}
                required
                onChange={(e) => setExpiresOn(e.target.value)}
              />
            </label>
          </div>
          {formError ? <div className="rounded-md bg-red-50 p-2 text-xs text-red-800">{formError}</div> : null}
          <button type="submit" className={buttonClass} disabled={creating}>
            {creating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />} สร้างรหัส
          </button>
        </form>
        {issued ? (
          <div className="mt-4 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs">
            <p className="flex items-center gap-1 text-sm font-semibold text-amber-900">
              <KeyRound size={16} aria-hidden /> รหัสของ {issued.code.name} ({issued.code.org})
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-white px-3 py-1 font-mono text-base tracking-widest">{issued.plaintext}</code>
              <button
                type="button"
                className={buttonGhostClass}
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(issued.plaintext)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "คัดลอกแล้ว" : "คัดลอก"}
              </button>
            </div>
            <p className="text-amber-900">
              ใช้ได้ถึง {fmtDateTime(issued.code.expiresAt)} — แจ้งรหัสนี้ให้ผู้ใช้ทางช่องทางที่ปลอดภัย ระบบจะไม่แสดงรหัสนี้อีก หากหายให้ยกเลิกและออกรหัสใหม่
              ผู้ใช้กรอกที่หน้า &quot;เข้าสู่ระบบ&quot; ช่อง &quot;รหัสสำหรับบุคคลภายนอก&quot;
            </p>
          </div>
        ) : null}
      </Card>

      <Card title="รหัสที่ออกแล้ว">
        {state.kind === "loading" ? (
          <LoadingState />
        ) : state.kind === "error" ? (
          <ErrorState
            message={state.message}
            action={
              <button type="button" className={buttonGhostClass} onClick={() => void load()}>
                ลองใหม่
              </button>
            }
          />
        ) : state.codes.length === 0 ? (
          <EmptyState message="ยังไม่มีรหัส" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-brand-50 text-brand-900">
                <tr>
                  <th className="px-2 py-2 font-semibold">ชื่อ / หน่วยงาน</th>
                  <th className="px-2 py-2 font-semibold">สถานะ</th>
                  <th className="px-2 py-2 font-semibold">ใช้ได้ถึง</th>
                  <th className="px-2 py-2 font-semibold">ใช้ล่าสุด</th>
                  <th className="px-2 py-2 text-right font-semibold">ครั้ง</th>
                  <th className="px-2 py-2 font-semibold">ออกโดย</th>
                  <th className="px-2 py-2 font-semibold">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {state.codes.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="px-2 py-2">
                      <span className="font-medium">{c.name}</span>
                      <span className="block text-slate-500">{c.org}</span>
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                      {c.revokedBy ? <span className="block text-slate-500">โดย {c.revokedBy.name}</span> : null}
                    </td>
                    <td className="px-2 py-2">{fmtDateTime(c.expiresAt)}</td>
                    <td className="px-2 py-2">{c.lastUsedAt ? fmtDateTime(c.lastUsedAt) : "-"}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(c.useCount)}</td>
                    <td className="px-2 py-2">
                      {c.createdBy.name}
                      <span className="block text-slate-500">{fmtDateTime(c.createdAt)}</span>
                    </td>
                    <td className="px-2 py-2">
                      {c.status === "revoked" ? (
                        "-"
                      ) : confirmId === c.id ? (
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            disabled={busyId === c.id}
                            onClick={() => void revoke(c.id)}
                          >
                            {busyId === c.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Ban size={14} aria-hidden />} ยืนยันยกเลิก
                          </button>
                          <button type="button" className={buttonGhostClass} onClick={() => setConfirmId(null)}>
                            ไม่
                          </button>
                        </div>
                      ) : (
                        <button type="button" className={buttonGhostClass} onClick={() => setConfirmId(c.id)}>
                          <Ban size={14} aria-hidden /> ยกเลิกรหัส
                        </button>
                      )}
                      {rowError?.id === c.id ? <p className="mt-1 text-red-700">{rowError.message}</p> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
