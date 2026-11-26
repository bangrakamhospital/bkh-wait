import "server-only";

import { isWaitDbConfigured, pgQuery, WaitDbConfigError, withPgTransaction } from "@/lib/db/pg";
import { validation } from "@/lib/http";

/**
 * Ward overrides + bed departments (PostgreSQL wait.ward_config /
 * wait.department) on top of the HOSxP ward list that the sync worker
 * copies into wait.his_ward. The merge itself is the view
 * wait.ward_catalog (db/003_hosxp_sync.sql) — the one definition of ward
 * name, capacity, visibility, virtual flag and department.
 */

/**
 * Wards treated as virtual when they have no ward_config row. Must match
 * the default in the wait.ward_catalog view.
 */
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

/** One active HOSxP ward with its config applied (a wait.ward_catalog row). */
export interface CatalogWard {
  wardCode: string;
  hisName: string;
  hisBeds: number;
  hasConfig: boolean;
  displayName: string | null;
  bedCapacity: number | null;
  configDepartmentCode: string | null;
  wardName: string;
  beds: number;
  visible: boolean;
  isVirtual: boolean;
  sortOrder: number;
  departmentCode: string;
  departmentName: string;
  departmentSort: number;
}

export interface CatalogRow {
  ward_code: string;
  his_name: string;
  his_beds: number;
  has_config: boolean;
  display_name: string | null;
  bed_capacity: number | null;
  config_department_code: string | null;
  ward_name: string;
  beds: number;
  visible: boolean;
  is_virtual: boolean;
  sort_order: number;
  department_code: string;
  department_name: string;
  department_sort: number;
}

export const CATALOG_COLUMNS = `ward_code, his_name, his_beds, has_config, display_name, bed_capacity,
  config_department_code, ward_name, beds, visible, is_virtual, sort_order,
  department_code, department_name, department_sort`;

export function toCatalogWard(r: CatalogRow): CatalogWard {
  return {
    wardCode: r.ward_code,
    hisName: r.his_name,
    hisBeds: r.his_beds,
    hasConfig: r.has_config,
    displayName: r.display_name,
    bedCapacity: r.bed_capacity,
    configDepartmentCode: r.config_department_code,
    wardName: r.ward_name,
    beds: r.beds,
    visible: r.visible,
    isVirtual: r.is_virtual,
    sortOrder: r.sort_order,
    departmentCode: r.department_code,
    departmentName: r.department_name,
    departmentSort: r.department_sort,
  };
}

function requirePg(): void {
  if (!isWaitDbConfigured()) throw new WaitDbConfigError("wait database is not configured");
}

/** Active HOSxP wards (as of the last sync) with config applied. */
export async function getWardCatalog(): Promise<CatalogWard[]> {
  requirePg();
  const rows = await pgQuery<CatalogRow>(
    `SELECT ${CATALOG_COLUMNS} FROM ward_catalog WHERE active ORDER BY sort_order, ward_code`,
  );
  return rows.map(toCatalogWard);
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

export async function getDepartmentSettings(): Promise<DepartmentSettings> {
  requirePg();
  const [catalog, depts] = await Promise.all([
    getWardCatalog(),
    pgQuery<{ department_code: string; name: string; sort_order: number }>(
      "SELECT department_code, name, sort_order FROM department ORDER BY sort_order, department_code",
    ),
  ]);
  return {
    departments: depts.map((d) => ({
      departmentCode: d.department_code,
      name: d.name,
      sortOrder: d.sort_order,
      wardCodes: catalog.filter((w) => w.configDepartmentCode === d.department_code).map((w) => w.wardCode),
    })),
    wards: catalog.map((w) => ({
      wardCode: w.wardCode,
      hisName: w.hisName,
      hisBeds: w.hisBeds,
      displayName: w.displayName,
      bedCapacity: w.bedCapacity,
      visible: w.visible,
      isVirtual: w.isVirtual,
      sortOrder: w.sortOrder,
      departmentCode: w.configDepartmentCode,
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
  const active = new Set((await getWardCatalog()).map((w) => w.wardCode));
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

