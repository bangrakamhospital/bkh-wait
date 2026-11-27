import type { OpdBoard } from "@/lib/opd/types";
import { fmtNum, waitTone } from "../format";
import { Card, StatTile } from "../ui";
import { OpdClinicTable } from "./OpdClinicTable";
import { OpdFlowSection } from "./OpdFlowSection";
import { OpdHourlyChart } from "./OpdHourlyChart";
import { OpdSceneLoader } from "./OpdSceneLoader";

const minutes = (n: number | null): string => (n === null ? "-" : fmtNum(Math.round(n)));

export function OpdView({ board }: { board: OpdBoard }) {
  const t = board.totals;
  // The current counts (รอซักประวัติ / รอพบแพทย์ ...) live in the flow
  // section only, so the page shows one number per status. The tiles below
  // are cumulative / time measures of the doctor queue.
  return (
    <>
      <OpdFlowSection flow={board.flow} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="พบแพทย์แล้ววันนี้ (สะสม)"
          value={fmtNum(t.seenToday)}
          unit="ราย"
          tone="green"
          hint="แพทย์เปิดตรวจที่ห้องตรวจ ไม่รวม ER"
        />
        <StatTile
          label="เวลารอพบแพทย์เฉลี่ย"
          value={minutes(t.avgWaitMinutes)}
          unit="นาที"
          tone={t.avgWaitMinutes === null ? "slate" : waitTone(t.avgWaitMinutes)}
          hint="ลงทะเบียน → พบแพทย์"
        />
        <StatTile
          label="เวลารอ (มัธยฐาน)"
          value={minutes(t.medianWaitMinutes)}
          unit="นาที"
          tone={t.medianWaitMinutes === null ? "slate" : waitTone(t.medianWaitMinutes)}
        />
        <StatTile
          label="รอนานสุดขณะนี้"
          value={t.waitingNow > 0 ? fmtNum(Math.round(t.longestWaitMinutes)) : "-"}
          unit="นาที"
          tone={t.waitingNow > 0 ? waitTone(t.longestWaitMinutes) : "slate"}
          hint="ในผู้ที่ยังไม่พบแพทย์ขณะนี้"
        />
      </div>

      <OpdClinicTable clinics={board.clinics} totals={t} />

      <Card title="ห้องตรวจผู้ป่วยนอกแบบ 3 มิติ">
        <OpdSceneLoader clinics={board.clinics} />
      </Card>

      <OpdHourlyChart points={board.hourly} />
    </>
  );
}
