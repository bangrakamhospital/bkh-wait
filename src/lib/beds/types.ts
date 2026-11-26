// Shared contract between the data layer (src/lib/beds/*, owned by sr) and
// the UI (src/components/*, src/app/* pages, owned by jr). Aggregate counts
// only — no patient-identifying fields ever cross this boundary.

/** departmentCode of the "ไม่ระบุแผนก" group (wards without a department). */
export const NO_DEPARTMENT_CODE = "_none";

/**
 * Occupancy of one ward at the last HOSxP sync (PostgreSQL wait.ward_state,
 * written by scripts/sync-hosxp.mjs; definitions in scripts/lib/hosxp.mjs).
 */
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
  /**
   * Physical beds of the ward in HOSxP order (bedno/roomno), occupied flag only —
   * no patient data. Lets the 3D scene draw the real beds and identify a click.
   */
  bedSlots: BedSlot[];
};

/** One physical bed (public, non-identifying). */
export type BedSlot = {
  bedno: string;
  /** HOSxP bed name/number shown to staff, e.g. "12" or "ห้องพิเศษ 3". */
  bedName: string;
  roomName: string | null;
  occupied: boolean;
};

/**
 * Patient on a bed — RESTRICTED. Only returned by the authenticated staff
 * endpoint (GET /api/beds/occupants?ward=), every call audit-logged; never in
 * the public board, snapshots, or the central API.
 */
export type BedOccupant = {
  bedno: string;
  bedName: string;
  hn: string;
  /** YYYY-MM-DD */
  admitDate: string;
  lengthOfStayDays: number;
  spcltyName: string | null;
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
  /** ISO time of the last successful HOSxP sync (the data is as of then). */
  asOf: string;
  /** true when asOf is older than 30 minutes (sync worker not running). */
  stale: boolean;
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

/**
 * Daily bed census of one ward (PostgreSQL wait.daily_census), one row per
 * ward per day. Filled by the HOSxP sync job; also the payload of the
 * central API (/api/v1/census).
 */
export type DailyCensus = {
  date: string; // YYYY-MM-DD (Asia/Bangkok)
  wardCode: string;
  wardName: string;
  departmentCode: string;
  departmentName: string;
  beds: number;
  /** Beds in use at the last sync of the day (for a closed day: the last sync before midnight). */
  bedsInUse: number;
  /** max(beds - bedsInUse, 0) */
  available: number;
  /** (beds - available) / beds * 100, 1 decimal, 0 when beds = 0 */
  occupancyPct: number;
  /** Highest beds-in-use seen across that day's syncs. */
  peakBedsInUse: number;
  /** Admissions that day (ipt.regdate = date). */
  admitted: number;
  /** Discharges that day (ipt.dchdate = date). */
  discharged: number;
  /**
   * Inpatient days = patients present at midnight at the end of the day.
   * Provisional (= patients present now) until the day is finalized.
   */
  patientDays: number;
  /**
   * true once the day is closed: the first sync after midnight recomputes
   * admitted / discharged / patientDays from HOSxP for the whole day and
   * the row never changes again.
   */
  finalized: boolean;
  /** ISO time of the last sync that updated this row. */
  updatedAt: string;
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
