"use client";

import { useMemo, useState } from "react";
import type { BedBoard } from "@/lib/beds/types";
import { summarize } from "./beds";
import { BedSceneLoader } from "./BedSceneLoader";
import { DepartmentCards } from "./DepartmentCards";
import { DepartmentTable, type DepartmentRow } from "./DepartmentTable";
import { fmtNum, fmtPct, occupancyTone } from "./format";
import { Card, Chip, StatTile } from "./ui";
import { WardCards } from "./WardCards";

export function DashboardView({ board }: { board: BedBoard }) {
  const [filter, setFilter] = useState("");

  const realWards = board.wards;

  const rows = useMemo<DepartmentRow[]>(() => {
    const out: DepartmentRow[] = [];
    for (const d of board.departments) {
      const ws = realWards.filter((w) => d.wardCodes.includes(w.wardCode));
      if (ws.length > 0) out.push({ code: d.departmentCode, name: d.departmentName, summary: summarize(ws) });
    }
    return out;
  }, [board.departments, realWards]);

  const spcltyByDept = useMemo(
    () => Object.fromEntries(board.departments.map((d) => [d.departmentCode, d.byDepartment])),
    [board.departments],
  );

  const dept = board.departments.find((d) => d.departmentCode === filter) ?? null;
  const shownWards = dept ? realWards.filter((w) => dept.wardCodes.includes(w.wardCode)) : realWards;
  // Unfiltered, "รอส่งกลับ" must match the server total, which also counts
  // waiting requests without a ward (they belong to no ward card).
  const summed = summarize(shownWards);
  const totals = dept ? summed : { ...summed, referWaiting: board.totals.referWaiting };
  const shownRows = dept ? rows.filter((r) => r.code === filter) : rows;
  // Summary table: one row per HOSxP ward (ward.name), not per department group.
  const wardRows: DepartmentRow[] = shownWards.map((w) => ({ code: w.wardCode, name: w.wardName, summary: summarize([w]) }));

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="กรองตามแผนก">
        <Chip active={filter === ""} onClick={() => setFilter("")}>
          ทั้งหมด
        </Chip>
        {rows.map((r) => (
          <Chip key={r.code} active={filter === r.code} onClick={() => setFilter(r.code)}>
            {r.name}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="เตียงทั้งหมด" value={fmtNum(totals.beds)} unit="เตียง" />
        <StatTile label="เตียงคนนอน" value={fmtNum(totals.inUse)} unit="เตียง" tone="amber" />
        <StatTile label="เตียงว่าง" value={fmtNum(totals.available)} unit="เตียง" tone="green" />
        <StatTile label="อัตราครองเตียง" value={fmtPct(totals.occupancyPct)} tone={occupancyTone(totals.occupancyPct)} />
        <StatTile label="รอส่งกลับ" value={fmtNum(totals.referWaiting)} unit="ราย" tone="brand" />
      </div>

      <DepartmentTable
        rows={wardRows}
        total={totals}
        filtered={dept !== null}
        title="สรุปเตียงรายหอผู้ป่วย (ward)"
        nameHeader="หอผู้ป่วย"
      />

      <Card title="ผังเตียงแบบ 3 มิติ">
        <BedSceneLoader wards={realWards} departments={board.departments} focusDept={filter} />
      </Card>

      <h2 className="text-base font-semibold">สรุปรายแผนก</h2>
      <DepartmentCards rows={shownRows} wards={realWards} spcltyByDept={spcltyByDept} />

      <h2 className="text-base font-semibold">รายหอผู้ป่วย</h2>
      <WardCards wards={shownWards} />
    </>
  );
}
