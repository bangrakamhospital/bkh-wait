import "server-only";

import { isWaitDbConfigured, WaitDbConfigError, withPgTransaction } from "@/lib/db/pg";
import { ApiError } from "@/lib/http";

import type { ClinicWait, OpdBoard, OpdHourPoint } from "./types";

/**
 * OPD "waiting to see a doctor" board, read ONLY from PostgreSQL: the last
 * successful OPD sync (scripts/sync-opd.mjs writes wait.opd_state /
 * opd_hourly / his_opd_clinic / sync_run job 'opd') + opd_clinic_config
 * overrides (view wait.opd_clinic_catalog). HOSxP definitions:
 * scripts/lib/hosxp-opd.mjs; contract: docs/api.md "OPD".
 *
 * - Hidden clinics (opd_clinic_config.visible = false) appear nowhere:
 *   not in clinics, hourly or totals.
 * - Medians are exact over any set of clinics: opd_state.wait_minutes keeps
 *   the (anonymous, sorted) waits of each clinic.
 * - stale: between 06:15 and 20:30 Asia/Bangkok the cron runs every 5 min,
 *   so older than STALE_AFTER_MS means it stopped; outside those hours the
 *   last run of the evening is expected — only flagged after 16 h.
 */

export const STALE_AFTER_MS = 15 * 60 * 1000;
const STALE_ANYTIME_MS = 16 * 60 * 60 * 1000;
const BOARD_TTL_MS = 10_000;
const store = globalThis as unknown as {
  __waitOpdBoard?: { at: number; value: Promise<OpdBoard> };
};

/** Minutes of the day in Asia/Bangkok (UTC+7, no DST). */
function bangkokMinutes(ms: number): number {
  const d = new Date(ms + 7 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** True when the last OPD sync is older than expected for the time of day. */
export function isOpdStale(asOf: string | null, now = Date.now()): boolean {
  if (!asOf) return true;
  const age = now - new Date(asOf).getTime();
  if (age > STALE_ANYTIME_MS) return true;
  const m = bangkokMinutes(now);
  return m >= 6 * 60 + 15 && m <= 20 * 60 + 30 && age > STALE_AFTER_MS;
}

export function median(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Nearest-rank percentile of a sorted array (same as the worker). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const roundOrNull = (x: number | null): number | null => (x === null ? null : Math.round(x));

/** Merge several sorted arrays into one sorted array. */
export function mergeSorted(lists: readonly (readonly number[])[]): number[] {
  return lists.flat().sort((a, b) => a - b);
}

interface StateRow {
  clinic_code: string;
  clinic_name: string;
  waiting_now: number;
  waiting_for_doctor: number;
  longest_wait_minutes: number;
  seen_today: number;
  visits_today: number;
  seen_last_hour: number;
  doctors_active: number;
  wait_minutes: number[];
}

interface HourRow {
  hour: number;
  arrived: number;
  seen: number;
  wait_sum: number;
  wait_n: number;
}

/** Rough wait for a patient arriving now (same rule as the worker, docs/api.md). */
export function estimateWait(waitingNow: number, seenLastHour: number): number | null {
  if (seenLastHour <= 0) return null;
  return Math.min(480, Math.ceil((waitingNow * 60) / seenLastHour));
}

async function buildBoard(): Promise<OpdBoard> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  return withPgTransaction(
    async (tx) => {
      const [last] = await tx.query<{ finished_at: string; his_today: string }>(
        `SELECT finished_at, his_today FROM sync_run
          WHERE ok AND job = 'opd' ORDER BY finished_at DESC LIMIT 1`,
      );
      if (!last) {
        throw new ApiError(503, "SYNC_NOT_READY", "ยังไม่มีข้อมูลการรอพบแพทย์จากการซิงก์ HOSxP");
      }
      const rows = await tx.query<StateRow>(
        `SELECT s.clinic_code, c.clinic_name, s.waiting_now, s.waiting_for_doctor, s.longest_wait_minutes,
                s.seen_today, s.visits_today, s.seen_last_hour, s.doctors_active, s.wait_minutes
           FROM opd_state s
           JOIN opd_clinic_catalog c ON c.clinic_code = s.clinic_code
          WHERE c.visible AND (c.active OR s.visits_today > 0 OR s.waiting_now > 0)
          ORDER BY c.sort_order, s.visits_today DESC, s.clinic_code`,
      );
      const hours = await tx.query<HourRow>(
        `SELECT h.hour, sum(h.arrived)::int AS arrived, sum(h.seen)::int AS seen,
                sum(h.wait_sum)::int AS wait_sum, sum(h.wait_n)::int AS wait_n
           FROM opd_hourly h
           JOIN opd_clinic_catalog c ON c.clinic_code = h.clinic_code
          WHERE h.visit_date = $1::date AND c.visible
          GROUP BY h.hour`,
        [last.his_today],
      );

      const clinics: ClinicWait[] = rows.map((r) => {
        const waits = r.wait_minutes ?? [];
        return {
          clinicCode: r.clinic_code,
          clinicName: r.clinic_name,
          waitingNow: r.waiting_now,
          waitingForDoctor: r.waiting_for_doctor,
          longestWaitMinutes: r.longest_wait_minutes,
          seenToday: r.seen_today,
          avgWaitMinutes: roundOrNull(mean(waits)),
          medianWaitMinutes: roundOrNull(median(waits)),
          p90WaitMinutes: roundOrNull(percentile(waits, 0.9)),
          doctorsActive: r.doctors_active,
          seenLastHour: r.seen_last_hour,
          estimatedWaitMinutes: estimateWait(r.waiting_now, r.seen_last_hour),
        };
      });

      const byHour = new Map(hours.map((h) => [h.hour, h]));
      const hourly: OpdHourPoint[] = Array.from({ length: 24 }, (_, hour) => {
        const h = byHour.get(hour);
        return {
          hour,
          arrived: h?.arrived ?? 0,
          seen: h?.seen ?? 0,
          avgWaitMinutes: h && h.wait_n > 0 ? Math.round(h.wait_sum / h.wait_n) : null,
        };
      });

      const all = mergeSorted(rows.map((r) => r.wait_minutes ?? []));
      const sum = (k: "waiting_now" | "waiting_for_doctor" | "seen_today") => rows.reduce((n, r) => n + r[k], 0);
      return {
        asOf: last.finished_at,
        stale: isOpdStale(last.finished_at),
        date: last.his_today,
        clinics,
        hourly,
        totals: {
          waitingNow: sum("waiting_now"),
          waitingForDoctor: sum("waiting_for_doctor"),
          seenToday: sum("seen_today"),
          avgWaitMinutes: roundOrNull(mean(all)),
          medianWaitMinutes: roundOrNull(median(all)),
          longestWaitMinutes: rows.reduce((m, r) => Math.max(m, r.longest_wait_minutes), 0),
        },
      };
    },
    { snapshot: true },
  );
}

/**
 * Current OPD board. Memoised for 10 s per process so many browsers
 * polling the public board cost PostgreSQL one set of queries.
 */
export function getOpdBoard(): Promise<OpdBoard> {
  const now = Date.now();
  const cached = store.__waitOpdBoard;
  if (cached && now - cached.at < BOARD_TTL_MS) return cached.value;
  const value = buildBoard();
  store.__waitOpdBoard = { at: now, value };
  value.catch(() => {
    if (store.__waitOpdBoard?.value === value) store.__waitOpdBoard = undefined;
  });
  return value;
}
