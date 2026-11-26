import type { NextRequest } from "next/server";

import { handleApi, HOSPCODE, preflight } from "@/lib/api/central";
import { parseCensusRange } from "@/lib/beds/census";
import { isOpdStale } from "@/lib/opd/board";
import { getLastOpdSyncAt, getOpdDaily } from "@/lib/opd/daily";

// Central API: daily OPD waits per clinic, ?from=YYYY-MM-DD&to=YYYY-MM-DD (<= 92 days).
export async function GET(request: NextRequest) {
  return handleApi(request, "/opd/daily", async (ctx) => {
    const q = request.nextUrl.searchParams;
    ctx.log.from = q.get("from")?.slice(0, 10) ?? null;
    ctx.log.to = q.get("to")?.slice(0, 10) ?? null;
    const { from, to } = parseCensusRange(q.get("from"), q.get("to"));
    const [{ rows, days }, lastSyncAt] = await Promise.all([getOpdDaily(from, to), getLastOpdSyncAt()]);
    ctx.log.rows = rows.length;
    return {
      hospcode: HOSPCODE,
      from,
      to,
      generatedAt: new Date().toISOString(),
      lastSyncAt,
      stale: isOpdStale(lastSyncAt),
      days,
      rows,
    };
  });
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
