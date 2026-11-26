// Shared contract between the data layer (src/lib/beds/*, owned by sr) and
// the UI (src/components/*, src/app/* pages, owned by jr). Aggregate counts
// only — no patient-identifying fields ever cross this boundary.

/** departmentCode of the "ไม่ระบุแผนก" group (wards without a department). */
export const NO_DEPARTMENT_CODE = "_none";

/** Occupancy of one ward right now (HOSxP ipt with dchdate IS NULL). */
export type WardOccupancy = {
  wardCode: string;
  wardName: string;
  /**
   * Bed capacity ("เตียงทั้งหมด"): ward_config.bed_capacity override, else
   * physical beds in HOSxP (bedno JOIN roomno on roomno.ward), else
   * ward.bedcount. Virtual wards (ward_config.is_virtual, e.g. 17 Home
   * Ward) never appear on the board.
   */
  beds: number;
  /** Patients currently admitted in the ward. */
  occupied: number;
  /**
   * Patients without a bed of their own: occupied minus the distinct
   * iptadm.bedno in use (no bed assigned, or sharing a placeholder bed).
   * Beds in use ("เตียงคนนอน") = occupied - occupiedNoBed.
   */
  occupiedNoBed: number;
  /** Free beds ("เตียงว่าง"): max(beds - (occupied - occupiedNoBed), 0). */
  available: number;
  /** (beds - available) / beds * 100, 0 when beds = 0 */
  occupancyPct: number;
  admittedToday: number;
  dischargedToday: number;
  /** Refer-back requests for this ward still waiting (status "waiting"). */
  referWaiting: number;
  /** Department group this ward belongs to (wait.ward_config.department_code). */
  departmentCode: string | null;
  /** Occupied beds in this ward split by clinical department (HOSxP ipt.spclty). */
  byDepartment: DepartmentCount[];
};

/** Occupied beds of one clinical department (HOSxP spclty). */
export type DepartmentCount = {
  spcltyCode: string;
  spcltyName: string;
  occupied: number;
};

/**
 * One bed department ("แผนก") = a group of wards configured in
 * wait.department (e.g. อายุรกรรม = wards 01+02). Beds are summed over its
 * wards; wards without a department fall into a "ไม่ระบุแผนก" group.
 */
export type DepartmentOccupancy = {
  departmentCode: string;
  departmentName: string;
  wardCodes: string[];
  /** Sums over the group's wards (same definitions as WardOccupancy). */
  beds: number;
  occupied: number;
  occupiedNoBed: number;
  available: number;
  occupancyPct: number;
  referWaiting: number;
  /** Patients in these wards split by spclty. */
  byDepartment: DepartmentCount[];
};

export type BedBoard = {
  /** ISO timestamp the data was read. */
  asOf: string;
  wards: WardOccupancy[];
  departments: DepartmentOccupancy[];
  /** Hospital-wide occupied beds by spclty. */
  bySpclty: DepartmentCount[];
  /** Sums over `wards`; referWaiting = all waiting requests (incl. no ward). */
  totals: {
    beds: number;
    occupied: number;
    occupiedNoBed: number;
    available: number;
    occupancyPct: number;
    referWaiting: number;
  };
};

/** One point of the occupancy history (PostgreSQL occupancy_snapshot). */
export type OccupancyPoint = {
  at: string; // ISO
  wardCode: string;
  occupied: number;
  beds: number;
  /** Beds in use (เตียงคนนอน) at that time; null for rows taken before migration 002. */
  bedsInUse: number | null;
};

export type ReferStatus = "waiting" | "accepted" | "admitted" | "cancelled";

/** A request from the regional hospital to send a patient back here. */
export type ReferBackRequest = {
  id: number;
  /** Free-text case reference from the sending hospital (no name / CID / HN). */
  caseRef: string;
  fromHospital: string;
  wardCode: string | null;
  diagnosisNote: string;
  status: ReferStatus;
  requestedAt: string; // ISO
  acceptedAt: string | null;
  admittedAt: string | null;
  /** Minutes from requestedAt to admittedAt (or to now while not admitted). */
  waitMinutes: number;
  /** Created by the logged-in account (computed per session; no usernames exposed). */
  mine: boolean;
};
