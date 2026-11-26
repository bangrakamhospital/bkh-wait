import type { NextRequest } from "next/server";

import { handleApi, HOSPCODE, preflight } from "@/lib/api/central";
import { STALE_AFTER_MS } from "@/lib/beds/board";
import { getDailyCensus, getLastSyncAt, parseCensusRange } from "@/lib/beds/census";
import type { DailyCensus } from "@/lib/beds/types";

// Central API: daily bed census per ward, ?from=YYYY-MM-DD&to=YYYY-MM-DD (<= 92 days).
export async function GET(request: NextRequest) {
  return handleApi(request, "/census", async (ctx) => {
    const q = request.nextUrl.searchParams;
    ctx.log.from = q.get("from")?.slice(0, 10) ?? null;
    ctx.log.to = q.get("to")?.slice(0, 10) ?? null;
    const { from, to } = parseCensusRange(q.get("from"), q.get("to"));
    const [rows, lastSyncAt] = await Promise.all([getDailyCensus(from, to), getLastSyncAt()]);
    ctx.log.rows = rows.length;

    const byDate = new Map<string, DailyCensus[]>();
    for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    const days = [...byDate].map(([date, list]) => {
      const sum = (k: "beds" | "bedsInUse" | "available" | "peakBedsInUse" | "admitted" | "discharged" | "patientDays") =>
        list.reduce((n, r) => n + r[k], 0);
      const beds = sum("beds");
      const available = sum("available");
      return {
        date,
        finalized: list.every((r) => r.finalized),
        wards: list.length,
        beds,
        bedsInUse: sum("bedsInUse"),
        available,
        occupancyPct: beds > 0 ? Math.round(((beds - available) / beds) * 1000) / 10 : 0,
        admitted: sum("admitted"),
        discharged: sum("discharged"),
        patientDays: sum("patientDays"),
      };
    });

    return {
      hospcode: HOSPCODE,
      from,
      to,
      generatedAt: new Date().toISOString(),
      lastSyncAt,
      stale: lastSyncAt === null || Date.now() - new Date(lastSyncAt).getTime() > STALE_AFTER_MS,
      days,
      rows,
    };
  });
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
