import type { WardOccupancy } from "@/lib/beds/types";
import { bedsInUse } from "./beds";
import { fmtNum, fmtPct, occupancyTone } from "./format";
import { Badge, Card, EmptyState, ProgressBar } from "./ui";

export function WardCards({ wards }: { wards: WardOccupancy[] }) {
  if (wards.length === 0) return <EmptyState message="ไม่พบข้อมูลหอผู้ป่วย" />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {wards.map((w) => {
        const tone = occupancyTone(w.occupancyPct);
        return (
          <Card key={w.wardCode}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">{w.wardName}</div>
                <div className="text-xs text-slate-500">หอ {w.wardCode}</div>
              </div>
              <Badge tone={tone}>{fmtPct(w.occupancyPct)}</Badge>
            </div>
            <div className="mt-3">
              <ProgressBar pct={w.occupancyPct} tone={tone} />
            </div>
            <div className="mt-2 flex justify-between text-xs">
              <span>
                เตียงคนนอน {fmtNum(bedsInUse(w))}/{fmtNum(w.beds)}
              </span>
              <span className="font-medium">ว่าง {fmtNum(w.available)}</span>
            </div>
            {w.occupiedNoBed > 0 ? (
              <div className="mt-1 text-xs text-amber-700">ไม่มีเตียง {fmtNum(w.occupiedNoBed)} ราย</div>
            ) : null}
            {bedsInUse(w) > w.beds ? (
              <div className="mt-1 text-xs text-red-700">เกินจำนวนเตียง {fmtNum(bedsInUse(w) - w.beds)} เตียง</div>
            ) : null}
            <div className="mt-1 text-xs text-slate-500">
              รับวันนี้ {fmtNum(w.admittedToday)} | จำหน่าย {fmtNum(w.dischargedToday)} | รอส่งกลับ {fmtNum(w.referWaiting)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
