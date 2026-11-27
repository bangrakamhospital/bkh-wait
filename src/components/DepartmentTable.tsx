import { fmtNum, fmtPct, occupancyTone } from "./format";
import type { BedSummary } from "./beds";
import { Badge, Card } from "./ui";

export type DepartmentRow = { code: string; name: string; summary: BedSummary };

export function DepartmentTable({
  rows,
  total,
  filtered = false,
  title = "สรุปเตียงรายแผนก",
  nameHeader = "แผนก",
}: {
  rows: DepartmentRow[];
  total: BedSummary;
  /** A department filter is active: the total row covers only `rows`. */
  filtered?: boolean;
  title?: string;
  nameHeader?: string;
}) {
  const showNoBed = total.noBed > 0;
  const cell = "py-2 pr-3 text-right tabular-nums";
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-brand-100 text-slate-600">
            <tr>
              <th className="py-2 pr-3 text-left">{nameHeader}</th>
              <th className={cell}>เตียงทั้งหมด</th>
              <th className={cell}>เตียงคนนอน</th>
              <th className={cell}>เตียงว่าง</th>
              {showNoBed ? <th className={cell}>ไม่มีเตียง</th> : null}
              <th className={cell}>อัตราครองเตียง</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-b border-brand-50">
                <td className="py-2 pr-3">{r.name}</td>
                <td className={cell}>{fmtNum(r.summary.beds)}</td>
                <td className={cell}>{fmtNum(r.summary.inUse)}</td>
                <td className={`${cell} font-medium`}>{fmtNum(r.summary.available)}</td>
                {showNoBed ? <td className={cell}>{fmtNum(r.summary.noBed)}</td> : null}
                <td className={cell}>
                  <Badge tone={occupancyTone(r.summary.occupancyPct)}>{fmtPct(r.summary.occupancyPct)}</Badge>
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-2 pr-3">{filtered ? "รวม" : "รวมทั้งโรงพยาบาล"}</td>
              <td className={cell}>{fmtNum(total.beds)}</td>
              <td className={cell}>{fmtNum(total.inUse)}</td>
              <td className={cell}>{fmtNum(total.available)}</td>
              {showNoBed ? <td className={cell}>{fmtNum(total.noBed)}</td> : null}
              <td className={cell}>
                <Badge tone={occupancyTone(total.occupancyPct)}>{fmtPct(total.occupancyPct)}</Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}
