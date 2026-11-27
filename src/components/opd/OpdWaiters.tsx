"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, FlaskConical, ScanLine, ShieldCheck, X } from "lucide-react";

import type { ClinicWaiters, OpdWaiter } from "@/lib/opd/waiter-types";
import { fmtDateTime, fmtNum, waitTone } from "../format";
import { Badge, Chip, EmptyState, LoadingState } from "../ui";

/**
 * Who is waiting in a clinic (RESTRICTED: HN). Clicking a waiting count or
 * the longest wait in OpdClinicTable opens this panel, which fetches
 * GET /api/opd/waiters?clinic= on every open (each view is audit-logged
 * server side). HNs live only in this component's state while the panel is
 * open: never in labels, tooltips, URLs, logs or storage.
 */

export type WaiterFilter = "all" | "screening" | "doctor" | "over180";

/** Waits above this (minutes) are flagged for follow-up. */
const FOLLOW_UP_MINUTES = 180;

type Target = { clinicCode: string; clinicName: string; filter: WaiterFilter };

type LoadState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "forbidden" }
  | { kind: "limited" }
  | { kind: "error" }
  | { kind: "ready"; data: ClinicWaiters };

const OpenContext = createContext<((t: Target, from: HTMLElement) => void) | null>(null);

const timeFmt = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const fmtTime = (iso: string | null): string => (iso ? timeFmt.format(new Date(iso)) : "-");

/** Minutes shown and sorted on: since screening when screened, else since registration. */
const waited = (w: OpdWaiter): number => w.minutesSinceScreening ?? w.minutesSinceRegistration;

export function OpdWaitersProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = useCallback((t: Target, from: HTMLElement) => {
    returnFocus.current = from;
    setTarget(t);
  }, []);
  const close = useCallback(() => {
    setTarget(null);
    returnFocus.current?.focus();
  }, []);
  return (
    <OpenContext.Provider value={open}>
      {children}
      {target ? <WaitersPanel key={`${target.clinicCode}|${target.filter}`} target={target} onClose={close} /> : null}
    </OpenContext.Provider>
  );
}

/** A table number that opens the panel (only rendered for values > 0). */
export function WaitersTrigger({
  clinicCode,
  clinicName,
  filter,
  label,
  children,
}: {
  clinicCode: string;
  clinicName: string;
  filter: WaiterFilter;
  /** Accessible name, e.g. "ดูรายชื่อผู้รอพบแพทย์ คลินิก X" (no patient data). */
  label: string;
  children: ReactNode;
}) {
  const open = useContext(OpenContext);
  if (!open) return <>{children}</>;
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      onClick={(e) => open({ clinicCode, clinicName, filter }, e.currentTarget)}
      className="rounded-sm text-brand-700 underline decoration-dotted underline-offset-2 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </button>
  );
}

function WaitersPanel({ target, onClose }: { target: Target; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<WaiterFilter>(target.filter);
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/opd/waiters?clinic=${encodeURIComponent(target.clinicCode)}`, {
          cache: "no-store",
          signal: ctl.signal,
        });
        if (r.status === 401) return setState({ kind: "guest" });
        if (r.status === 403) return setState({ kind: "forbidden" });
        if (r.status === 429) return setState({ kind: "limited" });
        if (!r.ok) return setState({ kind: "error" });
        const data = (await r.json()) as ClinicWaiters;
        setState({ kind: "ready", data: { ...data, waiters: Array.isArray(data.waiters) ? data.waiters : [] } });
      } catch {
        if (!ctl.signal.aborted) setState({ kind: "error" });
      }
    })();
    return () => ctl.abort();
  }, [target.clinicCode]);

  // Focus the close button, Esc closes, Tab stays inside the dialog, page does not scroll behind it.
  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-3xl flex-col bg-surface shadow-xl"
      >
        <div className="flex items-start justify-between gap-2 border-b border-brand-100 px-4 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              ผู้ที่ยังไม่พบแพทย์ · {target.clinicName}
            </h2>
            <p className="text-xs text-slate-500">เรียงตามเวลารอนานสุดก่อน · ใช้ติดตามผู้ป่วยที่รอนานเกินควร</p>
          </div>
          <button
            ref={closeBtn}
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="ปิด"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <PanelBody state={state} filter={filter} setFilter={setFilter} />
        </div>
      </div>
    </div>
  );
}

function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "red" }) {
  return (
    <div className={`rounded-md p-3 text-sm ${tone === "red" ? "bg-red-50 text-red-800" : "bg-brand-50 text-slate-700"}`}>
      {children}
    </div>
  );
}

function PanelBody({
  state,
  filter,
  setFilter,
}: {
  state: LoadState;
  filter: WaiterFilter;
  setFilter: (f: WaiterFilter) => void;
}) {
  switch (state.kind) {
    case "loading":
      return <LoadingState message="กำลังโหลดรายชื่อผู้รอ..." />;
    case "guest":
      return (
        <Notice>
          รายชื่อผู้ป่วย (HN) ดูได้เฉพาะเจ้าหน้าที่โรงพยาบาลที่เข้าสู่ระบบ{" "}
          <a href="/login?next=/opd" className="font-medium text-brand-700 underline">
            เข้าสู่ระบบเจ้าหน้าที่
          </a>
        </Notice>
      );
    case "forbidden":
      return <Notice>บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลผู้ป่วย</Notice>;
    case "limited":
      return <Notice tone="red">เปิดดูบ่อยเกินกำหนด (30 ครั้งต่อนาที) กรุณารอสักครู่แล้วลองใหม่</Notice>;
    case "error":
      return <Notice tone="red">โหลดรายชื่อผู้รอไม่สำเร็จ กรุณาลองใหม่</Notice>;
    case "ready":
      return <WaiterList data={state.data} filter={filter} setFilter={setFilter} />;
  }
}

function WaiterList({
  data,
  filter,
  setFilter,
}: {
  data: ClinicWaiters;
  filter: WaiterFilter;
  setFilter: (f: WaiterFilter) => void;
}) {
  const current = data.waiters.filter((w) => !w.stale);
  const stale = data.waiters.filter((w) => w.stale);
  const count: Record<WaiterFilter, number> = {
    all: current.length,
    screening: current.filter((w) => w.stage === "screening").length,
    doctor: current.filter((w) => w.stage === "doctor").length,
    over180: current.filter((w) => waited(w) > FOLLOW_UP_MINUTES).length,
  };
  const shown = current
    .filter(
      (w) =>
        filter === "all" ||
        (filter === "over180" ? waited(w) > FOLLOW_UP_MINUTES : w.stage === filter),
    )
    .sort((a, b) => waited(b) - waited(a) || (a.queueNo ?? Infinity) - (b.queueNo ?? Infinity));
  const chips: { key: WaiterFilter; label: string }[] = [
    { key: "all", label: "ทั้งหมด" },
    { key: "screening", label: "รอซักประวัติ/คัดกรอง" },
    { key: "doctor", label: "รอพบแพทย์" },
    { key: "over180", label: "รอเกิน 3 ชม." },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="กรองตามสถานะ">
        {chips.map((c) => (
          <Chip key={c.key} active={filter === c.key} onClick={() => setFilter(c.key)}>
            {c.label} {fmtNum(count[c.key])}
          </Chip>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState message="ไม่มีผู้รอในกลุ่มนี้" />
      ) : (
        <WaiterTable waiters={shown} />
      )}

      {stale.length > 0 ? (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <h3 className="flex items-center gap-1 text-sm font-semibold text-amber-800">
            <AlertTriangle size={16} aria-hidden />
            ลงทะเบียนเกิน 8 ชม. ยังไม่ได้พบแพทย์และยังไม่ปิด visit ({fmtNum(stale.length)} ราย)
          </h3>
          <p className="text-xs text-amber-800">
            ไม่นับในตัวเลขของตาราง อาจกลับบ้านไปแล้วโดยไม่ได้ปิด visit ควรตรวจสอบและปิด visit ใน HOSxP
          </p>
          <WaiterTable waiters={[...stale].sort((a, b) => waited(b) - waited(a))} />
        </div>
      ) : null}

      <div className="space-y-1 border-t border-brand-100 pt-2 text-xs text-slate-500">
        <p>
          ข้อมูล ณ {fmtDateTime(data.asOf)} (ซิงก์จาก HOSxP ทุก 5 นาที) · เวลารอนับถึงเวลาซิงก์: ซักประวัติแล้วนับจากเวลาซักประวัติ
          ยังไม่ซักประวัตินับจากเวลาลงทะเบียน
        </p>
        <p>
          Lab ค้างผล = มีใบสั่ง Lab ที่ยังไม่ยืนยันผล · X-ray = มีใบสั่ง X-ray วันนี้ · อยู่ที่ = จุดบริการปัจจุบันใน HOSxP
        </p>
        <p className="flex items-center gap-1">
          <ShieldCheck size={14} aria-hidden />
          การเปิดดูรายชื่อทุกครั้งถูกบันทึกไว้ในระบบ (ผู้ดู เวลา คลินิก) ใช้เพื่อติดตามผู้ป่วยเท่านั้น ห้ามเผยแพร่
        </p>
      </div>
    </div>
  );
}

function WaiterTable({ waiters }: { waiters: OpdWaiter[] }) {
  const th = "whitespace-nowrap py-2 pr-3 text-left font-medium";
  const td = "whitespace-nowrap py-2 pr-3";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="border-b border-brand-100 text-slate-600">
          <tr>
            <th className={`${th} text-right`}>คิว</th>
            <th className={th}>HN</th>
            <th className={`${th} text-right`}>รอ (นาที)</th>
            <th className={th}>สถานะ</th>
            <th className={th}>อยู่ที่</th>
            <th className={`${th} text-right`}>ลงทะเบียน</th>
            <th className={`${th} text-right`}>ซักประวัติ</th>
            <th className={th}>หมายเหตุ</th>
          </tr>
        </thead>
        <tbody>
          {waiters.map((w, i) => {
            const m = waited(w);
            return (
              <tr key={`${w.hn}|${w.registeredAt}|${i}`} className="border-b border-brand-50 align-top">
                <td className={`${td} text-right tabular-nums`}>{w.queueNo === null ? "-" : w.queueNo}</td>
                <td className={`${td} font-semibold tabular-nums`}>{w.hn}</td>
                <td className={`${td} text-right`}>
                  <Badge tone={waitTone(m)}>{fmtNum(m)}</Badge>
                  <div className="mt-0.5 text-slate-500">
                    {w.minutesSinceScreening === null ? "หลังลงทะเบียน" : "หลังซักประวัติ"}
                  </div>
                </td>
                <td className={td}>
                  <Badge tone={w.stage === "doctor" ? "brand" : "slate"}>
                    {w.stage === "doctor" ? "รอพบแพทย์" : "รอซักประวัติ"}
                  </Badge>
                </td>
                <td className="min-w-32 py-2 pr-3">
                  {w.curDepName ?? "-"}
                  {w.curDep ? <span className="ml-1 text-slate-400">({w.curDep})</span> : null}
                </td>
                <td className={`${td} text-right tabular-nums`}>{fmtTime(w.registeredAt)}</td>
                <td className={`${td} text-right tabular-nums`}>{fmtTime(w.screenedAt)}</td>
                <td className="min-w-44 py-2 pr-3">
                  <div className="flex flex-wrap gap-1">
                    {m > FOLLOW_UP_MINUTES ? (
                      <Badge tone="red">
                        <AlertTriangle size={12} className="mr-0.5" aria-hidden />
                        ค้างเกิน 3 ชม. ควรตรวจสอบ
                      </Badge>
                    ) : null}
                    {w.labPending ? (
                      <Badge tone="amber">
                        <FlaskConical size={12} className="mr-0.5" aria-hidden />
                        Lab ค้างผล
                      </Badge>
                    ) : null}
                    {w.xrayOrdered ? (
                      <Badge tone="brand">
                        <ScanLine size={12} className="mr-0.5" aria-hidden />
                        X-ray
                      </Badge>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
