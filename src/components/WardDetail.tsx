import type { WardOccupancy } from "@/lib/beds/types";
import { bedsInUse } from "./beds";
import { fmtNum, fmtPct, occupancyTone } from "./format";
import { Badge, SpcltyBar } from "./ui";

export function WardDetail({ ward }: { ward: WardOccupancy | null }) {
  if (!ward) {
    return <div className="text-xs text-slate-500">เลื่อนเมาส์หรือคลิกที่ตึกเพื่อดูรายละเอียดหอผู้ป่วย</div>;
  }
  const tone = occupancyTone(ward.occupancyPct);
  const used = bedsInUse(ward);
  const over = used > ward.beds;
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">
          {ward.wardCode} {ward.wardName}
        </span>
        <Badge tone={tone}>{fmtPct(ward.occupancyPct)}</Badge>
        {over ? <Badge tone="red">เกินจำนวนเตียง</Badge> : null}
      </div>
      <div>
        เตียงทั้งหมด {fmtNum(ward.beds)} | เตียงคนนอน {fmtNum(used)} | เตียงว่าง {fmtNum(ward.available)}
      </div>
      <div>
        รับใหม่วันนี้ {fmtNum(ward.admittedToday)} | จำหน่ายวันนี้ {fmtNum(ward.dischargedToday)} | รอส่งกลับ{" "}
        {fmtNum(ward.referWaiting)}
      </div>
      {ward.occupiedNoBed > 0 ? <div className="text-amber-700">ไม่มีเตียง {fmtNum(ward.occupiedNoBed)} ราย</div> : null}
      <div className="pt-1">
        <div className="mb-1 text-slate-600">ผู้ป่วยแยกตามแผนกการรักษา</div>
        <SpcltyBar items={ward.byDepartment} />
      </div>
    </div>
  );
}
