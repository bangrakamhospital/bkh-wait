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
          label="ซักประวัติ → พบแพทย์ (มัธยฐาน)"
          value={minutes(t.screenToDoctor.medianMinutes)}
          unit="นาที"
          tone={t.screenToDoctor.medianMinutes === null ? "slate" : waitTone(t.screenToDoctor.medianMinutes)}
          hint={`เฉลี่ย ${minutes(t.screenToDoctor.avgMinutes)} · P90 ${minutes(t.screenToDoctor.p90Minutes)} นาที (${fmtNum(t.screenToDoctor.n)} ราย)`}
        />
        <StatTile
          label="พบแพทย์ → รับยา (มัธยฐาน)"
          value={minutes(t.doctorToRx.medianMinutes)}
          unit="นาที"
          tone={t.doctorToRx.medianMinutes === null ? "slate" : waitTone(t.doctorToRx.medianMinutes)}
          hint={`เฉลี่ย ${minutes(t.doctorToRx.avgMinutes)} · P90 ${minutes(t.doctorToRx.p90Minutes)} นาที (${fmtNum(t.doctorToRx.n)} ราย ที่รับยาแล้ว)`}
        />
        <StatTile
          label="รอนานสุดขณะนี้ (หลังซักประวัติ)"
          value={t.longestScreenWaitMinutes === null ? "-" : fmtNum(Math.round(t.longestScreenWaitMinutes))}
          unit="นาที"
          tone={t.longestScreenWaitMinutes === null ? "slate" : waitTone(t.longestScreenWaitMinutes)}
          hint="ผู้ที่ซักประวัติแล้วและยังรอพบแพทย์"
        />
      </div>

      <OpdClinicTable clinics={board.clinics} totals={t} />

      <Card title="จุดที่ผู้ป่วยนั่งรอ (แบบ 3 มิติ)">
        <OpdSceneLoader flow={board.flow} clinics={board.clinics} />
      </Card>

      <OpdHourlyChart points={board.hourly} />
    </>
  );
}
