"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LogOut, Plus } from "lucide-react";
import type { BedBoard, ReferBackRequest, ReferStatus } from "@/lib/beds/types";
import { fmtDateTime, fmtNum, fmtWait, type Tone } from "./format";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  buttonClass,
  buttonGhostClass,
  inputClass,
} from "./ui";

type SessionUser = { username: string; role: "staff" | "partner" };
type WardOption = { wardCode: string; wardName: string };
type ApiError = { error?: string; code?: string };

const STATUS_LABEL: Record<ReferStatus, string> = {
  waiting: "รอรับ",
  accepted: "รับแล้ว",
  admitted: "รับเข้าแล้ว",
  cancelled: "ยกเลิก",
};
const STATUS_TONE: Record<ReferStatus, Tone> = {
  waiting: "amber",
  accepted: "brand",
  admitted: "green",
  cancelled: "slate",
};
const STATUS_FILTERS: { value: "" | ReferStatus; label: string }[] = [
  { value: "", label: "ทุกสถานะ" },
  { value: "waiting", label: STATUS_LABEL.waiting },
  { value: "accepted", label: STATUS_LABEL.accepted },
  { value: "admitted", label: STATUS_LABEL.admitted },
  { value: "cancelled", label: STATUS_LABEL.cancelled },
];

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) throw new Error(body.error ?? "เกิดข้อผิดพลาด กรุณาลองใหม่");
  return body;
}

export function ReferQueue() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [wards, setWards] = useState<WardOption[]>([]);
  const [requests, setRequests] = useState<ReferBackRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | ReferStatus>("");
  const [ward, setWard] = useState("");
  const [days, setDays] = useState("30");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadRequests = useCallback(async () => {
    const q = new URLSearchParams({ days });
    if (status) q.set("status", status);
    if (ward) q.set("ward", ward);
    try {
      const body = await readJson<{ requests: ReferBackRequest[] }>(await fetch(`/api/refer?${q}`));
      setRequests(body.requests);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "โหลดข้อมูลไม่สำเร็จ");
    }
  }, [status, ward, days]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await readJson<{ user: SessionUser | null }>(await fetch("/api/session"));
        if (alive) setUser(s.user);
      } catch {
        if (alive) setUser(null);
      }
      try {
        const b = await readJson<BedBoard>(await fetch("/api/board"));
        if (alive) setWards(b.wards.map((w) => ({ wardCode: w.wardCode, wardName: w.wardName })));
      } catch {
        // ward filter simply stays empty
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      if (alive) await loadRequests();
    })();
    const id = setInterval(() => void loadRequests(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [user, loadRequests]);

  async function changeStatus(id: number, next: ReferStatus) {
    setBusy(true);
    setActionError(null);
    try {
      await readJson(
        await fetch(`/api/refer/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        }),
      );
      await loadRequests();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "เปลี่ยนสถานะไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    setUser(null);
    setRequests(null);
  }

  if (user === undefined) return <LoadingState />;

  const wardName = (code: string | null) =>
    code ? (wards.find((w) => w.wardCode === code)?.wardName ?? code) : "-";

  if (user === null) {
    return (
      <Card>
        <div className="space-y-3 py-6 text-center text-sm">
          <div>กรุณาเข้าสู่ระบบเพื่อดูและบันทึกคิวส่งกลับผู้ป่วย</div>
          <Link href="/login" className={buttonClass}>
            เข้าสู่ระบบ
          </Link>
        </div>
      </Card>
    );
  }

  const waitingCount = requests?.filter((r) => r.status === "waiting").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          ผู้ใช้: {user.username} ({user.role === "staff" ? "เจ้าหน้าที่โรงพยาบาลบางระกำ" : "โรงพยาบาลแม่ข่าย"})
        </div>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={() => setShowForm((v) => !v)}>
            <Plus size={14} aria-hidden /> เพิ่มคำขอส่งกลับ
          </button>
          <button type="button" className={buttonGhostClass} onClick={logout}>
            <LogOut size={14} aria-hidden /> ออกจากระบบ
          </button>
        </div>
      </div>

      {showForm ? (
        <CreateForm
          wards={wards}
          onDone={async () => {
            setShowForm(false);
            await loadRequests();
          }}
        />
      ) : null}

      <Card
        title="คิวส่งกลับผู้ป่วย"
        action={<span className="text-xs text-slate-500">รอรับ {fmtNum(waitingCount)} ราย</span>}
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-xs text-slate-600">สถานะ</span>
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as "" | ReferStatus)}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-600">หอผู้ป่วย</span>
            <select className={inputClass} value={ward} onChange={(e) => setWard(e.target.value)}>
              <option value="">ทุกหอ</option>
              {wards.map((w) => (
                <option key={w.wardCode} value={w.wardCode}>
                  {w.wardName}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-600">ช่วงเวลา</span>
            <select className={inputClass} value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">7 วันล่าสุด</option>
              <option value="30">30 วันล่าสุด</option>
              <option value="90">90 วันล่าสุด</option>
            </select>
          </label>
        </div>

        {actionError ? <div className="mb-2 rounded-md bg-red-50 p-2 text-xs text-red-800">{actionError}</div> : null}

        {error ? (
          <ErrorState message={error} />
        ) : requests === null ? (
          <LoadingState />
        ) : requests.length === 0 ? (
          <EmptyState message="ไม่มีคำขอตามเงื่อนไขที่เลือก" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-brand-100 text-slate-600">
                <tr>
                  <th className="py-2 pr-3">รหัสเคส</th>
                  <th className="pr-3">โรงพยาบาลต้นทาง</th>
                  <th className="pr-3">หอผู้ป่วย</th>
                  <th className="pr-3">หมายเหตุ</th>
                  <th className="pr-3">สถานะ</th>
                  <th className="pr-3">ขอเมื่อ</th>
                  <th className="pr-3">เวลารอ</th>
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-brand-50 align-top">
                    <td className="py-2 pr-3 font-medium">{r.caseRef}</td>
                    <td className="pr-3">{r.fromHospital}</td>
                    <td className="pr-3">{wardName(r.wardCode)}</td>
                    <td className="pr-3">{r.diagnosisNote || "-"}</td>
                    <td className="pr-3">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="pr-3">{fmtDateTime(r.requestedAt)}</td>
                    <td className="pr-3">{fmtWait(r.waitMinutes)}</td>
                    <td>
                      <RowActions request={r} role={user.role} busy={busy} onChange={changeStatus} />
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

function RowActions({
  request,
  role,
  busy,
  onChange,
}: {
  request: ReferBackRequest;
  role: "staff" | "partner";
  busy: boolean;
  onChange: (id: number, next: ReferStatus) => void;
}) {
  const { status, id, mine } = request;
  if (status === "admitted" || status === "cancelled") return <span className="text-slate-400">-</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {role === "staff" && status === "waiting" ? (
        <button type="button" className={buttonClass} disabled={busy} onClick={() => onChange(id, "accepted")}>
          รับเคส
        </button>
      ) : null}
      {role === "staff" && status === "accepted" ? (
        <button type="button" className={buttonClass} disabled={busy} onClick={() => onChange(id, "admitted")}>
          รับเข้าแล้ว
        </button>
      ) : null}
      {role === "staff" || mine ? (
        <button
          type="button"
          className={buttonGhostClass}
          disabled={busy}
          onClick={() => {
            if (window.confirm("ยืนยันการยกเลิกคำขอนี้?")) onChange(id, "cancelled");
          }}
        >
          ยกเลิก
        </button>
      ) : null}
    </div>
  );
}

function CreateForm({ wards, onDone }: { wards: WardOption[]; onDone: () => Promise<void> }) {
  const [caseRef, setCaseRef] = useState("");
  const [fromHospital, setFromHospital] = useState("");
  const [wardCode, setWardCode] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await readJson(
        await fetch("/api/refer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caseRef,
            fromHospital,
            wardCode: wardCode || null,
            diagnosisNote: note,
          }),
        }),
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
      setSaving(false);
    }
  }

  return (
    <Card title="เพิ่มคำขอส่งกลับ">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-slate-600">รหัสเคส (ห้ามใส่ชื่อ เลขบัตรประชาชน หรือ HN)</span>
          <input className={inputClass} value={caseRef} maxLength={60} required onChange={(e) => setCaseRef(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-600">โรงพยาบาลต้นทาง</span>
          <input className={inputClass} value={fromHospital} maxLength={120} required onChange={(e) => setFromHospital(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-600">หอผู้ป่วยที่ต้องการ</span>
          <select className={inputClass} value={wardCode} onChange={(e) => setWardCode(e.target.value)}>
            <option value="">ยังไม่ระบุ</option>
            {wards.map((w) => (
              <option key={w.wardCode} value={w.wardCode}>
                {w.wardName}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-600">หมายเหตุ/การวินิจฉัย</span>
          <input className={inputClass} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error ? <div className="rounded-md bg-red-50 p-2 text-xs text-red-800 sm:col-span-2">{error}</div> : null}
        <div className="sm:col-span-2">
          <button type="submit" className={buttonClass} disabled={saving}>
            {saving ? "กำลังบันทึก..." : "บันทึกคำขอ"}
          </button>
        </div>
      </form>
    </Card>
  );
}
