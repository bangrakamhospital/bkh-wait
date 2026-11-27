import { Info, Users } from "lucide-react";
import { FLOW_COLOR, FLOW_DEFS } from "@/lib/opd/flow";
import type { OpdFlow, OpdFlowKey } from "@/lib/opd/types";
import { fmtDateTime, fmtNum, fmtPct } from "../format";
import { Card, EmptyState } from "../ui";

/** One fixed color per bucket: tile dot, stacked bar, legend and the 3D scene match. */
const bucketColor = (key: OpdFlowKey): string => FLOW_COLOR[key].bg;

const definitionOf = new Map(FLOW_DEFS.map((d) => [d.key, d.definition]));

/**
 * Today's OPD visits (same number as bkh-kpi "visit ผู้ป่วยนอก") split into
 * where each visit is now. Every visit is in exactly one bucket, so the
 * tiles always add up to the total.
 */
export function OpdFlowSection({ flow }: { flow: OpdFlow | null }) {
  if (!flow) {
    return (
      <Card title="visit ผู้ป่วยนอกวันนี้">
        <EmptyState message="ยังไม่มีข้อมูลสถานะ visit วันนี้ (รอการซิงก์รอบถัดไป)" />
      </Card>
    );
  }
  const pct = (n: number) => (flow.total > 0 ? (n / flow.total) * 100 : 0);
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Users size={18} aria-hidden className="text-brand-600" />
          visit ผู้ป่วยนอกวันนี้
          <span className="text-2xl font-bold text-brand-700 tabular-nums">{fmtNum(flow.total)}</span>
          <span className="text-sm font-normal text-slate-500">ครั้ง</span>
        </span>
      }
      action={<span className="text-xs text-slate-500">สถานะ ณ {fmtDateTime(flow.asOf)}</span>}
    >
      <div className="space-y-3">
        <div
          className="flex h-4 w-full overflow-hidden rounded-full bg-slate-200"
          role="img"
          aria-label={`สัดส่วน visit วันนี้ทั้งหมด ${fmtNum(flow.total)} ครั้ง ตามสถานะปัจจุบัน`}
        >
          {flow.buckets
            .filter((b) => b.count > 0)
            .map((b) => (
              <div
                key={b.key}
                className={bucketColor(b.key)}
                style={{ width: `${pct(b.count)}%` }}
                title={`${b.label} ${fmtNum(b.count)} (${fmtPct(pct(b.count))})`}
              />
            ))}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {flow.buckets.map((b) => (
            <div key={b.key} className="rounded-lg border border-brand-100 p-3" title={definitionOf.get(b.key)}>
              <div className="flex items-center gap-1.5 text-sm text-slate-600">
                <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${bucketColor(b.key)}`} aria-hidden />
                {b.label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {fmtNum(b.count)}
                <span className="ml-1 text-xs font-normal text-slate-500">ครั้ง · {fmtPct(pct(b.count))}</span>
              </div>
            </div>
          ))}
        </div>

        <details className="text-xs text-slate-600">
          <summary className="inline-flex cursor-pointer items-center gap-1 text-slate-500">
            <Info size={14} aria-hidden />
            นิยามแต่ละกลุ่ม (1 visit อยู่ได้กลุ่มเดียว ผลรวมเท่ากับ visit ทั้งหมดของวัน)
          </summary>
          <ul className="mt-2 space-y-1">
            {FLOW_DEFS.map((d) => (
              <li key={d.key} className="flex gap-1.5">
                <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-sm ${bucketColor(d.key)}`} aria-hidden />
                <span>
                  <span className="font-medium">{d.label}</span>: {d.definition}
                </span>
              </li>
            ))}
            <li className="pt-1 text-slate-500">
              visit ทั้งหมด = ทุกการลงทะเบียนของวันใน HOSxP (รวม ER, ไม่รวม visit ที่ยกเลิก) ตรงกับ &quot;visit
              ผู้ป่วยนอก&quot; ของระบบ KPI โรงพยาบาล ถ้าเข้าได้หลายกลุ่ม ใช้ลำดับ: Admit → ER → กลับบ้าน →
              ห้องยา/การเงิน → รอซักประวัติ/รอพบแพทย์ → พบแพทย์แล้ว / Lab / บริการอื่น → อื่นๆ
            </li>
          </ul>
        </details>
      </div>
    </Card>
  );
}
