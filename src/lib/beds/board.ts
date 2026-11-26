import "server-only";

import { isWaitDbConfigured, pgQuery } from "@/lib/db/pg";

import {
  applyConfig,
  loadConfigOrNull,
  NO_DEPARTMENT_CODE,
  NO_DEPARTMENT_NAME,
  type CatalogWard,
  type StoredConfig,
} from "./config";
import {
  fetchActiveWards,
  fetchDominantSpclty,
  fetchSpcltyCensus,
  fetchWardCensus,
  type HisSpcltyCount,
  type HisWardCensus,
} from "./his-source";
import { countWaitingByWard } from "./refer";
import type {
  BedBoard,
  DepartmentCount,
  DepartmentOccupancy,
  OccupancyPoint,
  WardOccupancy,
} from "./types";

export {
  createReferBack,
  listReferBack,
  updateReferStatus,
  type ListReferOptions,
} from "./refer";

/**
 * Bed board = HOSxP census (read-only, aggregates) + PostgreSQL overrides.
 * See ./his-source.ts for the SQL definitions.
 *
 * - Virtual wards (ward_config.is_virtual; default ward 17 Home Ward) and
 *   hidden wards (visible = false) never appear: not in wards,
 *   departments, bySpclty or totals.
 * - Department of a ward: ward_config.department_code; a ward with a
 *   config row but no department -> "_none"; a ward without a config row
 *   (or PostgreSQL not configured) -> its dominant spclty of the last year
 *   (code "sp-<spclty>"), or "_none" without history.
 */

const BOARD_TTL_MS = 10_000;
const store = globalThis as unknown as {
  __waitBoard?: { at: number; value: Promise<BedBoard> };
};

/** Drop the in-process board cache (after config / refer changes). */
export function invalidateBoardCache(): void {
  store.__waitBoard = undefined;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function bySpcltyDesc(a: DepartmentCount, b: DepartmentCount): number {
  return b.occupied - a.occupied || a.spcltyCode.localeCompare(b.spcltyCode);
}

function mergeCounts(lists: DepartmentCount[][]): DepartmentCount[] {
  const m = new Map<string, DepartmentCount>();
  for (const list of lists) {
    for (const c of list) {
      const cur = m.get(c.spcltyCode);
      if (cur) cur.occupied += c.occupied;
      else m.set(c.spcltyCode, { ...c });
    }
  }
  return [...m.values()].sort(bySpcltyDesc);
}

interface WardStats {
  ward: CatalogWard;
  census: HisWardCensus;
  spclty: DepartmentCount[];
}

/** All active wards with census (incl. hidden / virtual; callers filter). */
async function collectWardStats(cfg: StoredConfig | null): Promise<WardStats[]> {
  const [his, census, spclty] = await Promise.all([
    fetchActiveWards(),
    fetchWardCensus(),
    fetchSpcltyCensus(),
  ]);
  const spByWard = new Map<string, DepartmentCount[]>();
  for (const s of spclty as HisSpcltyCount[]) {
    const list = spByWard.get(s.wardCode) ?? [];
    list.push({ spcltyCode: s.spcltyCode, spcltyName: s.spcltyName, occupied: s.occupied });
    spByWard.set(s.wardCode, list);
  }
  return applyConfig(his, cfg).map((ward) => ({
    ward,
    census: census.get(ward.wardCode) ?? { occupied: 0, bedsInUse: 0, admittedToday: 0, dischargedToday: 0 },
    spclty: (spByWard.get(ward.wardCode) ?? []).sort(bySpcltyDesc),
  }));
}

function occupancyOf(beds: number, occupied: number, bedsInUse: number) {
  const inUse = Math.min(bedsInUse, occupied);
  const available = Math.max(beds - inUse, 0);
  return {
    occupiedNoBed: occupied - inUse,
    available,
    occupancyPct: pct(beds - available, beds),
  };
}

async function buildBoard(): Promise<BedBoard> {
  const cfg = await loadConfigOrNull();
  const [stats, waiting] = await Promise.all([collectWardStats(cfg), countWaitingByWard()]);
  const shown = stats
    .filter((s) => s.ward.visible && !s.ward.isVirtual)
    .sort((a, b) => a.ward.sortOrder - b.ward.sortOrder || a.ward.wardCode.localeCompare(b.ward.wardCode));

  // Fallback grouping only when some shown ward has no config row.
  const dominant = shown.some((s) => !s.ward.config) ? await fetchDominantSpclty() : new Map();

  const groupOf = (w: CatalogWard): { code: string; name: string; sort: number } => {
    if (w.config) {
      const d = w.config.departmentCode ? cfg?.departments.get(w.config.departmentCode) : undefined;
      return d
        ? { code: d.departmentCode, name: d.name, sort: d.sortOrder }
        : { code: NO_DEPARTMENT_CODE, name: NO_DEPARTMENT_NAME, sort: Number.MAX_SAFE_INTEGER };
    }
    const dom = dominant.get(w.wardCode);
    return dom
      ? { code: `sp-${dom.spcltyCode}`, name: dom.spcltyName, sort: 5000 }
      : { code: NO_DEPARTMENT_CODE, name: NO_DEPARTMENT_NAME, sort: Number.MAX_SAFE_INTEGER };
  };

  const wards: WardOccupancy[] = [];
  const groups = new Map<string, { name: string; sort: number; wards: WardOccupancy[] }>();
  for (const s of shown) {
    const g = groupOf(s.ward);
    const occ = occupancyOf(s.ward.beds, s.census.occupied, s.census.bedsInUse);
    const row: WardOccupancy = {
      wardCode: s.ward.wardCode,
      wardName: s.ward.wardName,
      beds: s.ward.beds,
      occupied: s.census.occupied,
      occupiedNoBed: occ.occupiedNoBed,
      available: occ.available,
      occupancyPct: occ.occupancyPct,
      admittedToday: s.census.admittedToday,
      dischargedToday: s.census.dischargedToday,
      referWaiting: waiting.get(s.ward.wardCode) ?? 0,
      departmentCode: g.code,
      byDepartment: s.spclty,
    };
    wards.push(row);
    const grp = groups.get(g.code) ?? { name: g.name, sort: g.sort, wards: [] };
    grp.wards.push(row);
    groups.set(g.code, grp);
  }

  const sum = (list: WardOccupancy[], k: "beds" | "occupied" | "occupiedNoBed" | "available" | "referWaiting") =>
    list.reduce((n, w) => n + w[k], 0);

  const departments: DepartmentOccupancy[] = [...groups]
    .sort(([ca, a], [cb, b]) => a.sort - b.sort || ca.localeCompare(cb))
    .map(([code, g]) => {
      const beds = sum(g.wards, "beds");
      const available = sum(g.wards, "available");
      return {
        departmentCode: code,
        departmentName: g.name,
        wardCodes: g.wards.map((w) => w.wardCode),
        beds,
        occupied: sum(g.wards, "occupied"),
        occupiedNoBed: sum(g.wards, "occupiedNoBed"),
        available,
        occupancyPct: pct(beds - available, beds),
        referWaiting: sum(g.wards, "referWaiting"),
        byDepartment: mergeCounts(g.wards.map((w) => w.byDepartment)),
      };
    });

  const beds = sum(wards, "beds");
  const available = sum(wards, "available");
  let referWaiting = 0;
  for (const n of waiting.values()) referWaiting += n;

  return {
    asOf: new Date().toISOString(),
    wards,
    departments,
    bySpclty: mergeCounts(wards.map((w) => w.byDepartment)),
    totals: {
      beds,
      occupied: sum(wards, "occupied"),
      occupiedNoBed: sum(wards, "occupiedNoBed"),
      available,
      occupancyPct: pct(beds - available, beds),
      referWaiting,
    },
  };
}

/**
 * Current bed board. Memoised for 10 s per process so many browsers
 * polling the public board cost HOSxP one set of queries.
 */
export function getBedBoard(): Promise<BedBoard> {
  const now = Date.now();
  const cached = store.__waitBoard;
  if (cached && now - cached.at < BOARD_TTL_MS) return cached.value;
  const value = buildBoard();
  store.__waitBoard = { at: now, value };
  // A failure must not stay cached.
  value.catch(() => {
    if (store.__waitBoard?.value === value) store.__waitBoard = undefined;
  });
  return value;
}

/** Occupancy history from wait.occupancy_snapshot ([] without PostgreSQL). */
export async function getOccupancyTrend(hours: number, wardCode?: string | null): Promise<OccupancyPoint[]> {
  if (!isWaitDbConfigured()) return [];
  const h = Math.min(Math.max(Math.trunc(hours), 1), 168);
  const rows = await pgQuery<{
    taken_at: string;
    ward_code: string;
    occupied: number;
    beds: number;
    beds_in_use: number | null;
  }>(
    `SELECT s.taken_at, s.ward_code, s.occupied, s.beds, s.beds_in_use
       FROM occupancy_snapshot s
       LEFT JOIN ward_config c ON c.ward_code = s.ward_code
      WHERE s.taken_at >= now() - make_interval(hours => $1)
        AND ($2::text IS NULL OR s.ward_code = $2)
        AND coalesce(c.is_virtual, false) = false
        AND coalesce(c.visible, true) = true
      ORDER BY s.taken_at, s.ward_code`,
    [h, wardCode ?? null],
  );
  return rows.map((r) => ({
    at: r.taken_at,
    wardCode: r.ward_code,
    occupied: r.occupied,
    beds: r.beds,
    bedsInUse: r.beds_in_use,
  }));
}

/**
 * Writes one occupancy_snapshot row per non-virtual active ward (hidden
 * wards included, so history survives un-hiding). The timestamp is
 * truncated to the minute; a second call within the same minute is a no-op.
 */
export async function takeOccupancySnapshot(): Promise<{ takenAt: string; wards: number }> {
  const cfg = await loadConfigOrNull();
  if (!cfg) {
    // Requires PostgreSQL: surfaces as 503 WAIT_DB_NOT_CONFIGURED / INTERNAL.
    await pgQuery("SELECT 1");
  }
  const stats = (await collectWardStats(cfg)).filter((s) => !s.ward.isVirtual);
  const codes = stats.map((s) => s.ward.wardCode);
  const occupied = stats.map((s) => s.census.occupied);
  const beds = stats.map((s) => s.ward.beds);
  // Same clamp as occupancyOf: never more beds in use than patients.
  const bedsInUse = stats.map((s) => Math.min(s.census.bedsInUse, s.census.occupied));
  const [row] = await pgQuery<{ taken_at: string }>(
    `WITH t AS (SELECT date_trunc('minute', now()) AS taken_at),
          ins AS (
            INSERT INTO occupancy_snapshot (taken_at, ward_code, occupied, beds, beds_in_use)
            SELECT t.taken_at, x.ward_code, x.occupied, x.beds, x.beds_in_use
              FROM t, unnest($1::text[], $2::int[], $3::int[], $4::int[]) AS x(ward_code, occupied, beds, beds_in_use)
            ON CONFLICT (taken_at, ward_code) DO NOTHING
          )
     SELECT taken_at FROM t`,
    [codes, occupied, beds, bedsInUse],
  );
  return { takenAt: row.taken_at, wards: codes.length };
}
