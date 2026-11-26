import type { ClinicWait, OpdBoard } from "@/lib/opd/types";
import { fmtNum, waitTone } from "../format";
import { Badge, Card, EmptyState } from "../ui";

const cell = "py-2 pr-3 text-right tabular-nums";

function WaitCell({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <>-</>;
  return <Badge tone={waitTone(minutes)}>{fmtNum(Math.round(minutes))}</Badge>;
}

export function OpdClinicTable({ clinics, totals }: { clinics: ClinicWait[]; totals: OpdBoard["totals"] }) {
  const doctors = clinics.reduce((s, c) => s + c.doctorsActive, 0);
  return (
    <Card title="การรอพบแพทย์รายแผนก (นาที)">
      {clinics.length === 0 ? (
        <EmptyState message="ยังไม่มีข้อมูลผู้ป่วยนอกวันนี้" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-brand-100 text-slate-600">
              <tr>
                <th className="py-2 pr-3 text-left">แผนก / คลินิก</th>
                <th className={cell}>รอตอนนี้ (คน)</th>
                <th className={cell}>รอหน้าห้องตรวจ</th>
                <th className={cell}>ตรวจแล้ว</th>
                <th className={cell}>รอเฉลี่ย</th>
                <th className={cell}>มัธยฐาน</th>
                <th className={cell}>P90</th>
                <th className={cell}>รอนานสุด</th>
                <th className={cell}>แพทย์ที่ออกตรวจ</th>
                <th className={cell}>คาดว่าจะรอ</th>
              </tr>
            </thead>
            <tbody>
              {clinics.map((c) => (
                <tr key={c.clinicCode} className="border-b border-brand-50">
                  <td className="py-2 pr-3">{c.clinicName}</td>
                  <td className={`${cell} font-medium`}>{fmtNum(c.waitingNow)}</td>
                  <td className={cell}>{fmtNum(c.waitingForDoctor)}</td>
                  <td className={cell}>{fmtNum(c.seenToday)}</td>
                  <td className={cell}>
                    <WaitCell minutes={c.avgWaitMinutes} />
                  </td>
                  <td className={cell}>
                    <WaitCell minutes={c.medianWaitMinutes} />
                  </td>
                  <td className={cell}>
                    <WaitCell minutes={c.p90WaitMinutes} />
                  </td>
                  <td className={cell}>{c.waitingNow > 0 ? <WaitCell minutes={c.longestWaitMinutes} /> : "-"}</td>
                  <td className={cell}>{fmtNum(c.doctorsActive)}</td>
                  <td className={cell}>
                    <WaitCell minutes={c.estimatedWaitMinutes} />
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2 pr-3">รวมทั้งโรงพยาบาล</td>
                <td className={cell}>{fmtNum(totals.waitingNow)}</td>
                <td className={cell}>{fmtNum(totals.waitingForDoctor)}</td>
                <td className={cell}>{fmtNum(totals.seenToday)}</td>
                <td className={cell}>
                  <WaitCell minutes={totals.avgWaitMinutes} />
                </td>
                <td className={cell}>
                  <WaitCell minutes={totals.medianWaitMinutes} />
                </td>
                <td className={cell}>-</td>
                <td className={cell}>{totals.waitingNow > 0 ? <WaitCell minutes={totals.longestWaitMinutes} /> : "-"}</td>
                <td className={cell}>{fmtNum(doctors)}</td>
                <td className={cell}>-</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">
            สีเวลารอ: <span className="text-emerald-700">น้อยกว่า 30 นาที</span> ·{" "}
            <span className="text-amber-700">30-60 นาที</span> · <span className="text-orange-700">60-120 นาที</span> ·{" "}
            <span className="text-red-700">มากกว่า 120 นาที</span>
          </p>
        </div>
      )}
    </Card>
  );
}
