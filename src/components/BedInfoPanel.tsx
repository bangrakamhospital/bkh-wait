"use client";

import { X } from "lucide-react";
import type { BedOccupant, WardOccupancy } from "@/lib/beds/types";
import { fmtNum } from "./format";
import { Badge } from "./ui";

/** Bed picked in the 3D scene (public fields only). */
export type PickedBed = {
  key: string;
  wardCode: string;
  /** HOSxP bed number; null for a synthetic bed (ward without bed data). */
  bedno: string | null;
  bedName: string;
  roomName: string | null;
  occupied: boolean;
};

export type OccupantState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "forbidden" }
  | { kind: "error" }
  | { kind: "ready"; occupant: BedOccupant | null };

const dateFmt = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" });

function fmtDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? ymd : dateFmt.format(d);
}

/**
 * Small panel for the bed tapped in the 3D scene. Patient fields only appear
 * for a logged-in staff account; they are rendered here and nowhere else
 * (no hover labels, no logging, no storage).
 */
export function BedInfoPanel({
  bed,
  ward,
  occupant,
  onClose,
}: {
  bed: PickedBed;
  ward: WardOccupancy | null;
  occupant: OccupantState;
  onClose: () => void;
}) {
  return (
    <div className="w-72 max-w-[calc(100vw-3rem)] space-y-2 rounded-md bg-white/95 p-3 text-xs shadow-lg ring-1 ring-brand-100" role="dialog" aria-label={`เตียง ${bed.bedName}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">เตียง {bed.bedName}</div>
          <div className="text-slate-600">{ward ? `${ward.wardCode} ${ward.wardName}` : bed.wardCode}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-brand-50" aria-label="ปิด">
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-600">ห้อง {bed.roomName ?? "-"}</span>
        <Badge tone={bed.occupied ? "amber" : "green"}>{bed.occupied ? "มีผู้ป่วย" : "เตียงว่าง"}</Badge>
      </div>
      {bed.occupied ? <OccupantBlock bed={bed} state={occupant} /> : null}
    </div>
  );
}

function OccupantBlock({ bed, state }: { bed: PickedBed; state: OccupantState }) {
  const box = "rounded-md bg-brand-50 p-2";
  if (bed.bedno === null) return <div className={`${box} text-slate-600`}>ยังไม่มีข้อมูลเตียงรายเตียงจาก HOSxP</div>;
  switch (state.kind) {
    case "loading":
      return <div className={`${box} text-slate-600`}>กำลังโหลดข้อมูลผู้ป่วย...</div>;
    case "guest":
      return (
        <div className={box}>
          <a href="/login?next=/beds" className="font-medium text-brand-700 underline">
            เข้าสู่ระบบเจ้าหน้าที่เพื่อดู HN
          </a>
        </div>
      );
    case "forbidden":
      return <div className={`${box} text-slate-600`}>บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลผู้ป่วย</div>;
    case "error":
      return <div className={`${box} text-red-700`}>โหลดข้อมูลผู้ป่วยไม่สำเร็จ</div>;
    case "ready":
      if (!state.occupant) return <div className={`${box} text-slate-600`}>ไม่พบข้อมูลผู้ป่วยบนเตียงนี้</div>;
      return (
        <dl className={`${box} grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5`}>
          <dt className="text-slate-600">HN</dt>
          <dd className="font-semibold">{state.occupant.hn}</dd>
          <dt className="text-slate-600">วันที่รับไว้</dt>
          <dd>{fmtDate(state.occupant.admitDate)}</dd>
          <dt className="text-slate-600">นอนมาแล้ว</dt>
          <dd>{fmtNum(state.occupant.lengthOfStayDays)} วัน</dd>
          <dt className="text-slate-600">แผนกการรักษา</dt>
          <dd>{state.occupant.spcltyName ?? "-"}</dd>
        </dl>
      );
    default:
      return null;
  }
}
