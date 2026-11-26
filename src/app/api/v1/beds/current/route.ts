import { handleApi, HOSPCODE, preflight } from "@/lib/api/central";
import { getBedBoard } from "@/lib/beds/board";

// Central API: current beds per department / ward (last HOSxP sync).
export async function GET(request: Request) {
  return handleApi(request, "/beds/current", async () => {
    const board = await getBedBoard();
    const inUse = (o: { occupied: number; occupiedNoBed: number }) => o.occupied - o.occupiedNoBed;
    return {
      hospcode: HOSPCODE,
      asOf: board.asOf,
      stale: board.stale,
      totals: {
        beds: board.totals.beds,
        bedsInUse: inUse(board.totals),
        available: board.totals.available,
        occupancyPct: board.totals.occupancyPct,
        patients: board.totals.occupied,
      },
      departments: board.departments.map((d) => ({
        departmentCode: d.departmentCode,
        departmentName: d.departmentName,
        wardCodes: d.wardCodes,
        beds: d.beds,
        bedsInUse: inUse(d),
        available: d.available,
        occupancyPct: d.occupancyPct,
        patients: d.occupied,
      })),
      wards: board.wards.map((w) => ({
        wardCode: w.wardCode,
        wardName: w.wardName,
        departmentCode: w.departmentCode,
        beds: w.beds,
        bedsInUse: inUse(w),
        available: w.available,
        occupancyPct: w.occupancyPct,
        patients: w.occupied,
        admittedToday: w.admittedToday,
        dischargedToday: w.dischargedToday,
      })),
    };
  });
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
