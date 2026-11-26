import type { OpdBoard } from "@/lib/opd/types";
import { fmtNum, waitTone } from "../format";
import { Card, StatTile } from "../ui";
import { OpdClinicTable } from "./OpdClinicTable";
import { OpdHourlyChart } from "./OpdHourlyChart";
import { OpdSceneLoader } from "./OpdSceneLoader";

const minutes = (n: number | null): string => (n === null ? "-" : fmtNum(Math.round(n)));

export function OpdView({ board }: { board: OpdBoard }) {
  const t = board.totals;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label="รอพบแพทย์ตอนนี้" value={fmtNum(t.waitingNow)} unit="ราย" tone="brand" />
        <StatTile label="รอหน้าห้องตรวจ" value={fmtNum(t.waitingForDoctor)} unit="ราย" tone="amber" hint="ผ่านคัดกรองแล้ว" />
        <StatTile label="ตรวจแล้ววันนี้" value={fmtNum(t.seenToday)} unit="ราย" tone="green" />
        <StatTile
          label="เวลารอเฉลี่ย"
          value={minutes(t.avgWaitMinutes)}
          unit="นาที"
          tone={t.avgWaitMinutes === null ? "slate" : waitTone(t.avgWaitMinutes)}
        />
        <StatTile
          label="มัธยฐาน"
          value={minutes(t.medianWaitMinutes)}
          unit="นาที"
          tone={t.medianWaitMinutes === null ? "slate" : waitTone(t.medianWaitMinutes)}
        />
        <StatTile
          label="รอนานสุดขณะนี้"
          value={t.waitingNow > 0 ? fmtNum(Math.round(t.longestWaitMinutes)) : "-"}
          unit="นาที"
          tone={t.waitingNow > 0 ? waitTone(t.longestWaitMinutes) : "slate"}
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
