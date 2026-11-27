import type { ReactNode } from "react";
import type { ClinicWait, OpdBoard, WaitSegment } from "@/lib/opd/types";
import { fmtNum, fmtPct, waitTone } from "../format";
import { Badge, Card, EmptyState } from "../ui";
import { OpdWaitersProvider, WaitersTrigger, type WaiterFilter } from "./OpdWaiters";

const cell = "py-2 pr-3 text-right tabular-nums";
const groupHead = "border-b border-brand-100 px-2 pb-1 text-center font-medium";

/** Registered but not screened yet (OPD-SCREEN not done): waiting minus waiting-for-doctor. */
const waitingScreen = (x: { waitingNow: number; waitingForDoctor: number }) => Math.max(0, x.waitingNow - x.waitingForDoctor);

/** Share of the visits that should have both timestamps and do (0-100), null when there are none. */
const fillPct = (s: WaitSegment): number | null => (s.base > 0 ? ((s.n + s.excluded) / s.base) * 100 : null);

function WaitCell({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <>-</>;
  return <Badge tone={waitTone(minutes)}>{fmtNum(Math.round(minutes))}</Badge>;
}

/** avg / median / P90 / n-of-base cells of one segment. */
function SegmentCells({ s }: { s: WaitSegment }) {
  return (
    <>
      <td className={cell}>
        <WaitCell minutes={s.avgMinutes} />
      </td>
      <td className={cell}>
        <WaitCell minutes={s.medianMinutes} />
      </td>
      <td className={cell}>
        <WaitCell minutes={s.p90Minutes} />
      </td>
      <td
        className={`${cell} text-slate-500`}
        title={`คำนวณได้ ${s.n} ราย จากที่ควรมีเวลา ${s.base} ราย${s.excluded ? ` (ตัดค่าผิดปกติ ${s.excluded} ราย)` : ""}`}
      >
        {s.base > 0 ? `${fmtNum(s.n)}/${fmtNum(s.base)}` : "-"}
      </td>
    </>
  );
}

/**
 * A clinic's waiting number: clickable (opens the waiter list, staff only)
 * when > 0. The accessible name names the clinic only, never a patient.
 */
function WaitersCell({
  c,
  filter,
  what,
  value,
  children,
}: {
  c: ClinicWait;
  filter: WaiterFilter;
  what: string;
  value: number | null;
  children: ReactNode;
}) {
  if (value === null || value <= 0) return <>{children}</>;
  return (
    <WaitersTrigger clinicCode={c.clinicCode} clinicName={c.clinicName} filter={filter} label={`ดูรายชื่อ${what} ${c.clinicName}`}>
      {children}
    </WaitersTrigger>
  );
}

function FillNote({ label, s }: { label: string; s: WaitSegment }) {
  const pct = fillPct(s);
  return (
    <>
      {label} มีเวลาครบ {pct === null ? "-" : fmtPct(pct)} ({fmtNum(s.n + s.excluded)}/{fmtNum(s.base)} ราย)
      {s.excluded > 0 ? `, ตัดค่าติดลบหรือเกิน 8 ชม. ${fmtNum(s.excluded)} ราย` : ""}
    </>
  );
}

export function OpdClinicTable({ clinics, totals }: { clinics: ClinicWait[]; totals: OpdBoard["totals"] }) {
  const doctors = clinics.reduce((s, c) => s + c.doctorsActive, 0);
  // Clinics that saw patients but recorded no screening time (no OPD-SCREEN before the doctor).
  const noScreen = clinics.filter((c) => c.seenToday > 0 && c.screenToDoctor.n + c.screenToDoctor.excluded === 0);
  return (
    <OpdWaitersProvider>
      <Card title="ระยะเวลารอคอยรายแผนก (นาที)">
        {clinics.length === 0 ? (
          <EmptyState message="ยังไม่มีข้อมูลผู้ป่วยนอกวันนี้" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-brand-100 text-slate-600">
                <tr>
                  <th rowSpan={2} className="py-2 pr-3 text-left align-bottom">
                    แผนก / คลินิก
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    ยังไม่พบแพทย์ (คน)
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    รอซักประวัติ/คัดกรอง
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    รอพบแพทย์
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    พบแพทย์แล้ว
                  </th>
                  <th colSpan={4} className={`${groupHead} text-brand-700`}>
                    ซักประวัติ → พบแพทย์
                  </th>
                  <th colSpan={4} className={`${groupHead} text-emerald-700`}>
                    พบแพทย์ → รับยา
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    รอนานสุดขณะนี้ (หลังซักประวัติ)
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    แพทย์ที่ออกตรวจ
                  </th>
                  <th rowSpan={2} className={`${cell} align-bottom`}>
                    คาดว่าจะรอ (หลังซักประวัติ)
                  </th>
                </tr>
                <tr>
                  <th className={cell}>เฉลี่ย</th>
                  <th className={cell}>มัธยฐาน</th>
                  <th className={cell}>P90</th>
                  <th className={cell}>ราย</th>
                  <th className={cell}>เฉลี่ย</th>
                  <th className={cell}>มัธยฐาน</th>
                  <th className={cell}>P90</th>
                  <th className={cell}>ราย</th>
                </tr>
              </thead>
              <tbody>
                {clinics.map((c) => (
                  <tr key={c.clinicCode} className="border-b border-brand-50">
                    <td className="py-2 pr-3">{c.clinicName}</td>
                    <td className={`${cell} font-medium`}>
                      <WaitersCell c={c} filter="all" what="ผู้ที่ยังไม่พบแพทย์" value={c.waitingNow}>
                        {fmtNum(c.waitingNow)}
                      </WaitersCell>
                    </td>
                    <td className={cell}>
                      <WaitersCell c={c} filter="screening" what="ผู้รอซักประวัติ" value={waitingScreen(c)}>
                        {fmtNum(waitingScreen(c))}
                      </WaitersCell>
                    </td>
                    <td className={cell}>
                      <WaitersCell c={c} filter="doctor" what="ผู้รอพบแพทย์" value={c.waitingForDoctor}>
                        {fmtNum(c.waitingForDoctor)}
                      </WaitersCell>
                    </td>
                    <td className={cell}>{fmtNum(c.seenToday)}</td>
                    <SegmentCells s={c.screenToDoctor} />
                    <SegmentCells s={c.doctorToRx} />
                    <td className={cell}>
                      <WaitersCell c={c} filter="all" what="ผู้ที่รอนานสุด" value={c.waitingNow > 0 ? c.longestScreenWaitMinutes : null}>
                        <WaitCell minutes={c.longestScreenWaitMinutes} />
                      </WaitersCell>
                    </td>
                    <td className={cell}>{fmtNum(c.doctorsActive)}</td>
                    <td className={cell}>
                      <WaitCell minutes={c.estimatedDoctorWaitMinutes} />
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">รวมทุกคลินิก</td>
                  <td className={cell}>{fmtNum(totals.waitingNow)}</td>
                  <td className={cell}>{fmtNum(waitingScreen(totals))}</td>
                  <td className={cell}>{fmtNum(totals.waitingForDoctor)}</td>
                  <td className={cell}>{fmtNum(totals.seenToday)}</td>
                  <SegmentCells s={totals.screenToDoctor} />
                  <SegmentCells s={totals.doctorToRx} />
                  <td className={cell}>
                    <WaitCell minutes={totals.longestScreenWaitMinutes} />
                  </td>
                  <td className={cell}>{fmtNum(doctors)}</td>
                  <td className={cell}>-</td>
                </tr>
              </tbody>
            </table>
            <div className="mt-2 space-y-1 text-xs text-slate-500">
              <p>
                <span className="font-medium text-slate-600">กดตัวเลขผู้ที่ยังไม่พบแพทย์ / รอซักประวัติ / รอพบแพทย์ / รอนานสุด</span>{" "}
                เพื่อดูรายชื่อผู้รอ (HN, คิว, จุดที่อยู่, Lab/X-ray) เรียงตามเวลารอ เฉพาะเจ้าหน้าที่โรงพยาบาลที่เข้าสู่ระบบ
                การเปิดดูทุกครั้งถูกบันทึกไว้
              </p>
              <p>
                <span className="font-medium text-slate-600">ซักประวัติ → พบแพทย์</span> = เวลาเริ่มซักประวัติครั้งล่าสุดก่อนพบแพทย์
                (HOSxP บันทึกเวลาบริการ &quot;ซักประวัติ/คัดกรอง&quot;) ถึงเวลาแพทย์เปิดตรวจที่ห้องตรวจ นับผู้ที่พบแพทย์แล้ววันนี้ ·{" "}
                <FillNote label="วันนี้" s={totals.screenToDoctor} />
                {noScreen.length > 0 ? ` · ไม่มีเวลาซักประวัติในระบบ: ${noScreen.map((c) => c.clinicName).join(", ")}` : ""}
              </p>
              <p>
                <span className="font-medium text-slate-600">พบแพทย์ → รับยา</span> = เวลาแพทย์ปิดการตรวจ ถึงเวลาที่ห้องยาบันทึก
                &quot;ผู้จ่ายยา&quot; (ส่งมอบยาให้ผู้ป่วย) นับเฉพาะผู้ที่พบแพทย์และมีรายการยา ระหว่างวันนับเฉพาะผู้ที่รับยาแล้ว ·{" "}
                <FillNote label="วันนี้" s={totals.doctorToRx} />
              </p>
              <p>
                ราย = จำนวนที่คำนวณได้ / จำนวนที่ควรมีเวลาครบ · ตัดค่าติดลบหรือเกิน 8 ชั่วโมงออกจากสถิติ · รอนานสุดขณะนี้และคาดว่าจะรอ
                นับจากเวลาซักประวัติ (คาดว่าจะรอ = ผู้รอพบแพทย์ ÷ จำนวนที่แพทย์ตรวจได้ในชั่วโมงที่ผ่านมา)
              </p>
              <p>
                อ้างอิงนิยามเดิม ลงทะเบียน → พบแพทย์ (รวมเวลาไปเจาะเลือด/รอผล Lab ก่อนซักประวัติ): มัธยฐาน{" "}
                {totals.medianWaitMinutes === null ? "-" : fmtNum(totals.medianWaitMinutes)} นาที, P90{" "}
                {totals.p90WaitMinutes === null ? "-" : fmtNum(totals.p90WaitMinutes)} นาที
              </p>
              <p>
                ยังไม่พบแพทย์ = รอซักประวัติ/คัดกรอง + รอพบแพทย์ (ตรงกับ 2 กลุ่มแรกของ visit วันนี้ด้านบน)
                นับเฉพาะคลินิกที่มีแพทย์ตรวจ ไม่รวม ER, Lab อย่างเดียว, ทันตกรรม, คลินิกตา
              </p>
              <p>
                สีเวลารอ: <span className="text-emerald-700">น้อยกว่า 30 นาที</span> ·{" "}
                <span className="text-amber-700">30-60 นาที</span> · <span className="text-orange-700">60-120 นาที</span> ·{" "}
                <span className="text-red-700">มากกว่า 120 นาที</span>
              </p>
            </div>
          </div>
        )}
      </Card>
    </OpdWaitersProvider>
  );
}
