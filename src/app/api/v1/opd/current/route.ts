import { handleApi, HOSPCODE, preflight } from "@/lib/api/central";
import { getOpdBoard } from "@/lib/opd/board";

// Central API: current OPD waits per clinic (last OPD sync).
export async function GET(request: Request) {
  return handleApi(request, "/opd/current", async () => {
    const board = await getOpdBoard();
    return {
      hospcode: HOSPCODE,
      asOf: board.asOf,
      stale: board.stale,
      date: board.date,
      flow: board.flow,
      totals: board.totals,
      clinics: board.clinics,
    };
  });
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
