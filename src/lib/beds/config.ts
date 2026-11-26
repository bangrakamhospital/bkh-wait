import "server-only";

import { isWaitDbConfigured, pgQuery, WaitDbConfigError, WaitDbError, withPgTransaction } from "@/lib/db/pg";
import { validation } from "@/lib/http";

import { fetchActiveWards, type HisWard } from "./his-source";

/**
 * Ward overrides + bed departments (PostgreSQL wait.ward_config /
 * wait.department) merged with the HOSxP ward list.
 */

/** Wards treated as virtual when they have no ward_config row (or PG is not set up). */
export const DEFAULT_VIRTUAL_WARDS: ReadonlySet<string> = new Set(["17"]);

export { NO_DEPARTMENT_CODE } from "./types";
export const NO_DEPARTMENT_NAME = "ไม่ระบุแผนก";

export interface WardConfigRow {
  wardCode: string;
  displayName: string | null;
  bedCapacity: number | null;
  visible: boolean;
  isVirtual: boolean;
  sortOrder: number;
  departmentCode: string | null;
}

export interface DepartmentRow {
  departmentCode: string;
  name: string;
  sortOrder: number;
}

export interface StoredConfig {
  wards: Map<string, WardConfigRow>;
  departments: Map<string, DepartmentRow>;
}

/** A HOSxP active ward with its config applied. */
export interface CatalogWard {
  wardCode: string;
  hisName: string;
  hisBeds: number;
  wardName: string;
  beds: number;
  visible: boolean;
  isVirtual: boolean;
  sortOrder: number;
  /** null = no ward_config row (fallback grouping applies). */
  config: WardConfigRow | null;
}

async function readConfig(): Promise<StoredConfig> {
  const [wards, departments] = await Promise.all([
    pgQuery<{
      ward_code: string;
      display_name: string | null;
      bed_capacity: number | null;
      visible: boolean;
      is_virtual: boolean;
      sort_order: number;
      department_code: string | null;
    }>(
      `SELECT ward_code, display_name, bed_capacity, visible, is_virtual, sort_order, department_code
         FROM ward_config`,
    ),
    pgQuery<{ department_code: string; name: string; sort_order: number }>(
      "SELECT department_code, name, sort_order FROM department",
    ),
  ]);
  return {
    wards: new Map(
      wards.map((w) => [
        w.ward_code,
        {
          wardCode: w.ward_code,
          displayName: w.display_name,
          bedCapacity: w.bed_capacity,
          visible: w.visible,
          isVirtual: w.is_virtual,
          sortOrder: w.sort_order,
          departmentCode: w.department_code,
        },
      ]),
    ),
    departments: new Map(
      departments.map((d) => [
        d.department_code,
        { departmentCode: d.department_code, name: d.name, sortOrder: d.sort_order },
      ]),
    ),
  };
}

/**
 * Stored config, or null when PostgreSQL is not configured / unreachable
 * (the board then falls back to HOSxP defaults instead of failing).
 */
export async function loadConfigOrNull(): Promise<StoredConfig | null> {
  if (!isWaitDbConfigured()) return null;
  try {
    return await readConfig();
  } catch (err) {
    if (err instanceof WaitDbConfigError) return null;
    if (err instanceof WaitDbError) {
      console.error(`[beds] ward config unavailable, using HOSxP defaults: ${err.message}`);
      return null;
    }
    throw err;
  }
}

export function applyConfig(his: HisWard[], cfg: StoredConfig | null): CatalogWard[] {
  return his.map((w) => {
    const c = cfg?.wards.get(w.wardCode) ?? null;
    return {
      wardCode: w.wardCode,
      hisName: w.wardName,
      hisBeds: w.beds,
      wardName: c?.displayName?.trim() || w.wardName,
      beds: c?.bedCapacity ?? w.beds,
      visible: c?.visible ?? true,
      isVirtual: c ? c.isVirtual : DEFAULT_VIRTUAL_WARDS.has(w.wardCode),
      sortOrder: c?.sortOrder ?? 1000,
      config: c,
    };
  });
}

/** Active HOSxP wards with config applied (HOSxP must be reachable). */
export async function getWardCatalog(): Promise<CatalogWard[]> {
  const [his, cfg] = await Promise.all([fetchActiveWards(), loadConfigOrNull()]);
  return applyConfig(his, cfg);
}

/** Throws 400 unless `wardCode` is an active, non-virtual ward. */
export async function assertReferableWard(wardCode: string): Promise<void> {
  const ward = (await getWardCatalog()).find((w) => w.wardCode === wardCode);
  if (!ward || ward.isVirtual) {
    throw validation("wardCode ต้องเป็นรหัสหอผู้ป่วยที่เปิดใช้งาน");
  }
}

// ---------------------------------------------------------------------------
// GET / PUT /api/departments
// ---------------------------------------------------------------------------

export interface DepartmentSettings {
  departments: (DepartmentRow & { wardCodes: string[] })[];
  wards: {
    wardCode: string;
    hisName: string;
    hisBeds: number;
    displayName: string | null;
    bedCapacity: number | null;
    visible: boolean;
    isVirtual: boolean;
    sortOrder: number;
    departmentCode: string | null;
  }[];
}

function requirePg(): void {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
}

export async function getDepartmentSettings(): Promise<DepartmentSettings> {
  requirePg();
  const [his, cfg] = await Promise.all([fetchActiveWards(), readConfig()]);
  const catalog = applyConfig(his, cfg);
  const departments = [...cfg.departments.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.departmentCode.localeCompare(b.departmentCode))
    .map((d) => ({
      ...d,
      wardCodes: catalog
        .filter((w) => w.config?.departmentCode === d.departmentCode)
        .map((w) => w.wardCode),
    }));
  return {
    departments,
    wards: catalog
      .sort((a, b) => a.sortOrder - b.sortOrder || a.wardCode.localeCompare(b.wardCode))
      .map((w) => ({
        wardCode: w.wardCode,
        hisName: w.hisName,
        hisBeds: w.hisBeds,
        displayName: w.config?.displayName ?? null,
        bedCapacity: w.config?.bedCapacity ?? null,
        visible: w.visible,
        isVirtual: w.isVirtual,
        sortOrder: w.config?.sortOrder ?? 1000,
        departmentCode: w.config?.departmentCode ?? null,
      })),
  };
}

const DEPT_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;

function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw validation(`${field} ต้องเป็นข้อความ`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw validation(`${field} ต้องยาว ${min}-${max} ตัวอักษร`);
  return s;
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw validation(`${field} ต้องเป็นจำนวนเต็ม ${min}-${max}`);
  }
  return v;
}

function optional<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === undefined || v === null || v === "" ? null : parse(v);
}

interface ParsedPut {
  departments: DepartmentRow[];
  wards: WardConfigRow[];
}

function parsePut(body: Record<string, unknown>, activeWards: Set<string>): ParsedPut {
  if (!Array.isArray(body.departments) || body.departments.length > 50) {
    throw validation("departments ต้องเป็นรายการ (ไม่เกิน 50)");
  }
  if (!Array.isArray(body.wards) || body.wards.length > 100) {
    throw validation("wards ต้องเป็นรายการ (ไม่เกิน 100)");
  }
  const seenDept = new Set<string>();
  const departments = body.departments.map((raw, i): DepartmentRow => {
    if (!raw || typeof raw !== "object") throw validation(`departments[${i}] ไม่ถูกต้อง`);
    const d = raw as Record<string, unknown>;
    const code = str(d.departmentCode, `departments[${i}].departmentCode`, 1, 20);
    if (!DEPT_CODE_RE.test(code)) {
      throw validation(`departments[${i}].departmentCode ใช้ได้เฉพาะ a-z 0-9 _ - (ขึ้นต้นด้วย a-z/0-9)`);
    }
    if (seenDept.has(code)) throw validation(`departmentCode ซ้ำ: ${code}`);
    seenDept.add(code);
    return {
      departmentCode: code,
      name: str(d.name, `departments[${i}].name`, 1, 60),
      sortOrder: d.sortOrder === undefined ? (i + 1) * 10 : int(d.sortOrder, `departments[${i}].sortOrder`, -9999, 9999),
    };
  });
  const seenWard = new Set<string>();
  const wards = body.wards.map((raw, i): WardConfigRow => {
    if (!raw || typeof raw !== "object") throw validation(`wards[${i}] ไม่ถูกต้อง`);
    const w = raw as Record<string, unknown>;
    const code = str(w.wardCode, `wards[${i}].wardCode`, 1, 4);
    if (!activeWards.has(code)) throw validation(`wards[${i}].wardCode ไม่ใช่หอผู้ป่วยที่เปิดใช้งาน`);
    if (seenWard.has(code)) throw validation(`wardCode ซ้ำ: ${code}`);
    seenWard.add(code);
    const dept = optional(w.departmentCode, (v) => str(v, `wards[${i}].departmentCode`, 1, 20));
    if (dept !== null && !seenDept.has(dept)) {
      throw validation(`wards[${i}].departmentCode ไม่อยู่ใน departments`);
    }
    const bool = (v: unknown, field: string, def: boolean) => {
      if (v === undefined) return def;
      if (typeof v !== "boolean") throw validation(`${field} ต้องเป็น true/false`);
      return v;
    };
    return {
      wardCode: code,
      departmentCode: dept,
      displayName: optional(w.displayName, (v) => str(v, `wards[${i}].displayName`, 1, 80)),
      bedCapacity: optional(w.bedCapacity, (v) => int(v, `wards[${i}].bedCapacity`, 0, 999)),
      visible: bool(w.visible, `wards[${i}].visible`, true),
      isVirtual: bool(w.isVirtual, `wards[${i}].isVirtual`, DEFAULT_VIRTUAL_WARDS.has(code)),
      sortOrder: w.sortOrder === undefined ? (i + 1) * 10 : int(w.sortOrder, `wards[${i}].sortOrder`, -9999, 9999),
    };
  });
  return { departments, wards };
}

/**
 * Replaces the department list and upserts the given wards' config in one
 * transaction. Departments not listed are deleted (their wards fall back
 * to no department). Wards not listed keep their current config.
 */
export async function putDepartmentSettings(
  body: Record<string, unknown>,
  actor: string,
): Promise<DepartmentSettings> {
  requirePg();
  const active = new Set((await fetchActiveWards()).map((w) => w.wardCode));
  const parsed = parsePut(body, active);
  await withPgTransaction(async (tx) => {
    // Serialise concurrent edits of the whole grouping.
    await tx.query("LOCK TABLE department IN SHARE ROW EXCLUSIVE MODE");
    const codes = parsed.departments.map((d) => d.departmentCode);
    await tx.query("DELETE FROM department WHERE NOT (department_code = ANY($1::text[]))", [codes]);
    for (const d of parsed.departments) {
      await tx.query(
        `INSERT INTO department (department_code, name, sort_order, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (department_code) DO UPDATE
           SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [d.departmentCode, d.name, d.sortOrder, actor],
      );
    }
    for (const w of parsed.wards) {
      await tx.query(
        `INSERT INTO ward_config (ward_code, display_name, bed_capacity, visible, is_virtual,
                                  sort_order, department_code, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (ward_code) DO UPDATE
           SET display_name = EXCLUDED.display_name, bed_capacity = EXCLUDED.bed_capacity,
               visible = EXCLUDED.visible, is_virtual = EXCLUDED.is_virtual,
               sort_order = EXCLUDED.sort_order, department_code = EXCLUDED.department_code,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [w.wardCode, w.displayName, w.bedCapacity, w.visible, w.isVirtual, w.sortOrder, w.departmentCode, actor],
      );
    }
    await tx.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
       VALUES ($1, 'departments.replace', 'department', NULL, $2::jsonb)`,
      [actor, JSON.stringify(parsed)],
    );
  });
  return getDepartmentSettings();
}

