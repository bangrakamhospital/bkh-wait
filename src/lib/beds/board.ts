import "server-only";

import { isWaitDbConfigured, pgQuery, WaitDbConfigError, withPgTransaction } from "@/lib/db/pg";
import { ApiError } from "@/lib/http";

import { CATALOG_COLUMNS, toCatalogWard, type CatalogRow, type CatalogWard } from "./config";
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
 * Bed board, read ONLY from PostgreSQL: the last successful HOSxP sync
 * (scripts/sync-hosxp.mjs writes wait.his_ward / ward_state /
 * ward_spclty_state / sync_run) + ward_config overrides, merged by the view
 * wait.ward_catalog (name, capacity, visible, virtual, department). HOSxP
 * definitions: scripts/lib/hosxp.mjs.
 *
 * - Virtual wards (ward 17 Home Ward by default) and hidden wards never
 *   appear: not in wards, departments, bySpclty or totals.
 * - asOf = finish time of the last successful sync; stale when older than
 *   STALE_AFTER_MS (cron runs every 15 min, so two missed runs).
 */

export const STALE_AFTER_MS = 30 * 60 * 1000;
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

function occupancyOf(beds: number, occupied: number, bedsInUse: number) {
  const inUse = Math.min(bedsInUse, occupied);
  const available = Math.max(beds - inUse, 0);
  return {
    occupiedNoBed: occupied - inUse,
    available,
    occupancyPct: pct(beds - available, beds),
  };
}

interface StateRow {
  ward_code: string;
  occupied: number;
  beds_in_use: number;
  admitted_today: number;
  discharged_today: number;
}

interface SyncState {
  asOf: string;
  wards: { ward: CatalogWard; state: StateRow | undefined }[];
  spclty: Map<string, DepartmentCount[]>;
}

/** Shown wards + their state from the last committed sync (one snapshot). */
async function readSyncState(): Promise<SyncState> {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
  return withPgTransaction(
    async (tx) => {
      const [last] = await tx.query<{ finished_at: string }>(
        "SELECT finished_at FROM sync_run WHERE ok ORDER BY finished_at DESC LIMIT 1",
      );
      if (!last) {
        throw new ApiError(503, "SYNC_NOT_READY", "ยังไม่มีข้อมูลเตียงจากการซิงก์ HOSxP");
      }
      const catalog = await tx.query<CatalogRow>(
        `SELECT ${CATALOG_COLUMNS} FROM ward_catalog
          WHERE active AND visible AND NOT is_virtual
          ORDER BY sort_order, ward_code`,
      );
      const states = await tx.query<StateRow>(
        "SELECT ward_code, occupied, beds_in_use, admitted_today, discharged_today FROM ward_state",
      );
      const sp = await tx.query<{ ward_code: string; spclty_code: string; spclty_name: string; occupied: number }>(
        `SELECT x.ward_code, x.spclty_code,
                coalesce(nullif(btrim(s.name), ''), 'ไม่ระบุ') AS spclty_name, x.occupied
           FROM ward_spclty_state x
           LEFT JOIN his_spclty s ON s.spclty_code = x.spclty_code`,
      );
      const stateBy = new Map(states.map((r) => [r.ward_code, r]));
      const spclty = new Map<string, DepartmentCount[]>();
      for (const r of sp) {
        const list = spclty.get(r.ward_code) ?? [];
        list.push({ spcltyCode: r.spclty_code, spcltyName: r.spclty_name, occupied: r.occupied });
        spclty.set(r.ward_code, list);
      }
      for (const list of spclty.values()) list.sort(bySpcltyDesc);
      return {
        asOf: last.finished_at,
        wards: catalog.map((r) => ({ ward: toCatalogWard(r), state: stateBy.get(r.ward_code) })),
        spclty,
      };
    },
    { snapshot: true },
  );
}

async function buildBoard(): Promise<BedBoard> {
  const [sync, waiting] = await Promise.all([readSyncState(), countWaitingByWard()]);

  const wards: WardOccupancy[] = [];
  const groups = new Map<string, { name: string; sort: number; wards: WardOccupancy[] }>();
  for (const { ward: w, state } of sync.wards) {
    const occupied = state?.occupied ?? 0;
    const occ = occupancyOf(w.beds, occupied, state?.beds_in_use ?? 0);
    const row: WardOccupancy = {
      wardCode: w.wardCode,
      wardName: w.wardName,
      beds: w.beds,
      occupied,
      occupiedNoBed: occ.occupiedNoBed,
      available: occ.available,
      occupancyPct: occ.occupancyPct,
      admittedToday: state?.admitted_today ?? 0,
      dischargedToday: state?.discharged_today ?? 0,
      referWaiting: waiting.get(w.wardCode) ?? 0,
      departmentCode: w.departmentCode,
      byDepartment: sync.spclty.get(w.wardCode) ?? [],
    };
    wards.push(row);
    const grp = groups.get(w.departmentCode) ?? { name: w.departmentName, sort: w.departmentSort, wards: [] };
    grp.wards.push(row);
    groups.set(w.departmentCode, grp);
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
    asOf: sync.asOf,
    stale: Date.now() - new Date(sync.asOf).getTime() > STALE_AFTER_MS,
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
 * polling the public board cost PostgreSQL one set of queries.
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
