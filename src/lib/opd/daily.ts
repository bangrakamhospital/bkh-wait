import "server-only";

import { isWaitDbConfigured, pgQuery, WaitDbConfigError } from "@/lib/db/pg";

import { mean, median, mergeSorted, percentile } from "./board";
import type { OpdDaily } from "./types";

/** Daily OPD waits per clinic (wait.opd_daily, written by scripts/sync-opd.mjs). Visible clinics only. */

export interface OpdDayTotal {
  date: string;
  finalized: boolean;
  visits: number;
  seen: number;
  avgWaitMinutes: number | null;
  medianWaitMinutes: number | null;
  p90WaitMinutes: number | null;
  within60Pct: number | null;
}

const round1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);

export async function getOpdDaily(from: string, to: string): Promise<{ rows: OpdDaily[]; days: OpdDayTotal[] }> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  const raw = await pgQuery<{
    visit_date: string;
    clinic_code: string;
    clinic_name: string;
    visits: number;
    seen: number;
    avg_wait: number | null;
    median_wait: number | null;
    p90_wait: number | null;
    within60_pct: number | null;
    wait_minutes: number[];
    finalized: boolean;
  }>(
    `SELECT d.visit_date, d.clinic_code, coalesce(nullif(btrim(c.display_name), ''), d.clinic_name) AS clinic_name,
            d.visits, d.seen, d.avg_wait, d.median_wait, d.p90_wait, d.within60_pct, d.wait_minutes,
            d.finalized_at IS NOT NULL AS finalized
       FROM opd_daily d
       LEFT JOIN opd_clinic_config c ON c.clinic_code = d.clinic_code
      WHERE d.visit_date BETWEEN $1::date AND $2::date
        AND coalesce(c.visible, true)
      ORDER BY d.visit_date, coalesce(c.sort_order, 1000), d.visits DESC, d.clinic_code`,
    [from, to],
  );
  const rows: OpdDaily[] = raw.map((r) => ({
    date: r.visit_date,
    clinicCode: r.clinic_code,
    clinicName: r.clinic_name,
    visits: r.visits,
    seen: r.seen,
    avgWaitMinutes: r.avg_wait,
    medianWaitMinutes: r.median_wait,
    p90WaitMinutes: r.p90_wait,
    within60Pct: r.within60_pct,
    finalized: r.finalized,
  }));

  const byDate = new Map<string, typeof raw>();
  for (const r of raw) byDate.set(r.visit_date, [...(byDate.get(r.visit_date) ?? []), r]);
  const days: OpdDayTotal[] = [...byDate].map(([date, list]) => {
    const all = mergeSorted(list.map((r) => r.wait_minutes ?? []));
    return {
      date,
      finalized: list.every((r) => r.finalized),
      visits: list.reduce((n, r) => n + r.visits, 0),
      seen: list.reduce((n, r) => n + r.seen, 0),
      avgWaitMinutes: round1(mean(all)),
      medianWaitMinutes: round1(median(all)),
      p90WaitMinutes: round1(percentile(all, 0.9)),
      within60Pct: all.length ? round1((all.filter((m) => m <= 60).length / all.length) * 100) : null,
    };
  });
  return { rows, days };
}

/** Finish time of the last successful OPD sync, or null. */
export async function getLastOpdSyncAt(): Promise<string | null> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  const [row] = await pgQuery<{ finished_at: string }>(
    "SELECT finished_at FROM sync_run WHERE ok AND job = 'opd' ORDER BY finished_at DESC LIMIT 1",
  );
  return row?.finished_at ?? null;
}
