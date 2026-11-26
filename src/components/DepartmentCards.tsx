import { NO_DEPARTMENT_CODE, type WardOccupancy } from "@/lib/beds/types";
import type { DepartmentRow } from "./DepartmentTable";
import { fmtNum, fmtPct, occupancyTone } from "./format";
import { Badge, Card, EmptyState, ProgressBar, SpcltyBar } from "./ui";

export function DepartmentCards({
  rows,
  wards,
  spcltyByDept,
}: {
  rows: DepartmentRow[];
  wards: WardOccupancy[];
  spcltyByDept: Record<string, { spcltyCode: string; spcltyName: string; occupied: number }[]>;
}) {
  if (rows.length === 0) return <EmptyState message="ไม่พบข้อมูลแผนก" />;
  const num = "text-base font-semibold tabular-nums";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(({ code, name, summary: s }) => {
        const tone = occupancyTone(s.occupancyPct);
        const wardNames = wards.filter((w) => (w.departmentCode ?? NO_DEPARTMENT_CODE) === code).map((w) => w.wardName);
        return (
          <Card key={code}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold">{name}</div>
              <Badge tone={tone}>{fmtPct(s.occupancyPct)}</Badge>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className={num}>{fmtNum(s.beds)}</div>
                <div className="text-xs text-slate-500">เตียงทั้งหมด</div>
              </div>
              <div>
                <div className={num}>{fmtNum(s.inUse)}</div>
                <div className="text-xs text-slate-500">เตียงคนนอน</div>
              </div>
              <div>
                <div className={`${num} text-emerald-700`}>{fmtNum(s.available)}</div>
                <div className="text-xs text-slate-500">เตียงว่าง</div>
              </div>
            </div>
            <div className="mt-3">
              <ProgressBar pct={s.occupancyPct} tone={tone} />
            </div>
            {s.noBed > 0 ? (
              <div className="mt-1 text-xs text-amber-700">ไม่มีเตียง {fmtNum(s.noBed)} ราย</div>
            ) : null}
            <div className="mt-1 text-xs text-slate-500">หอผู้ป่วย: {wardNames.join(", ")}</div>
            <div className="mb-2 text-xs text-slate-500">รอส่งกลับ {fmtNum(s.referWaiting)} ราย</div>
            <SpcltyBar items={spcltyByDept[code] ?? []} />
          </Card>
        );
      })}
    </div>
  );
}
