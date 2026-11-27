// Shared contract for the OPD "waiting to see a doctor" board, between the
// data layer (scripts/lib/hosxp-opd.mjs + src/lib/opd/*, owned by sr) and the
// UI (src/components/opd/*, src/app/opd/*, owned by jr). Aggregate numbers
// only — never HN, VN, names, queue numbers tied to a person. The restricted
// staff-only waiter list (HN) has its own contract: ./waiter-types.ts.

/**
 * One measured wait segment (db/009, scripts/lib/hosxp-opd.mjs "Wait
 * segments"): minutes over the visits where both timestamps exist.
 *   screenToDoctor: screening (latest OPD-SCREEN begin before the doctor) → doctor exam start
 *   doctorToRx:     doctor exam end → medicine handed over (rx_dispenser_detail type 4 ผู้จ่ายยา)
 */
export type WaitSegment = {
  avgMinutes: number | null;
  medianMinutes: number | null;
  p90Minutes: number | null;
  /** Visits in the statistics. */
  n: number;
  /** Visits with both timestamps but a negative or > 480 min value (left out of the statistics). */
  excluded: number;
  /**
   * Visits that should have both timestamps: seen today (screenToDoctor) or
   * seen today with at least one drug item (doctorToRx). Fill rate = (n + excluded) / base.
   */
  base: number;
};

/** One OPD clinic / examination department (HOSxP kskdepartment or clinic). */
export type ClinicWait = {
  clinicCode: string;
  clinicName: string;
  /** Patients registered today who have not been seen by a doctor yet. */
  waitingNow: number;
  /** Of those, how many already passed screening (vital signs) and wait for the doctor room. */
  waitingForDoctor: number;
  /** Minutes the longest-waiting current patient has waited (registration → now). */
  longestWaitMinutes: number;
  /** Patients who saw a doctor today. */
  seenToday: number;
  /** Registration → doctor, minutes, over patients seen today (null when none). */
  avgWaitMinutes: number | null;
  medianWaitMinutes: number | null;
  p90WaitMinutes: number | null;
  /** Doctors who examined at least one patient in this clinic in the last hour. */
  doctorsActive: number;
  /** Seen in the last 60 minutes (throughput). */
  seenLastHour: number;
  /** Rough expected wait for a newly arriving patient, minutes (null when unknown). */
  estimatedWaitMinutes: number | null;
  /** Screening → doctor exam start, over patients seen today. */
  screenToDoctor: WaitSegment;
  /** Doctor exam end → medicine handed over, over patients seen today who received drugs so far. */
  doctorToRx: WaitSegment;
  /** Longest wait since screening among patients waiting now who were screened (null: none). */
  longestScreenWaitMinutes: number | null;
  /**
   * Rough wait for the doctor after screening now: waitingForDoctor at the
   * pace of the last hour (null when nobody was seen in the last hour).
   */
  estimatedDoctorWaitMinutes: number | null;
};

/** Hourly arrivals / seen for today's curve (Asia/Bangkok hours 0-23). */
export type OpdHourPoint = {
  hour: number;
  arrived: number;
  seen: number;
  /** Registration → doctor of those seen in this hour (kept for compatibility). */
  avgWaitMinutes: number | null;
  /** Screening → doctor of those seen in this hour. */
  avgScreenWaitMinutes: number | null;
};

/** Visit-flow bucket keys (db/008 CHECK list, scripts/lib/hosxp-opd.mjs FLOW_BUCKETS). */
export type OpdFlowKey =
  | "screening"
  | "doctor"
  | "after_doctor"
  | "lab"
  | "services"
  | "pharmacy"
  | "done"
  | "er"
  | "admit"
  | "other";

export type OpdFlowBucket = { key: OpdFlowKey; label: string; count: number };

/**
 * Where every visit of today is now. total = COUNT(*) FROM ovst of the day
 * (ER included, same as bkh-kpi "visit ผู้ป่วยนอก"); each visit is in
 * exactly one bucket, so sum(buckets.count) === total always.
 */
export type OpdFlow = {
  total: number;
  buckets: OpdFlowBucket[];
  /** ISO time of the sync that computed it. */
  asOf: string;
};

export type OpdBoard = {
  /** ISO time of the last successful OPD sync. */
  asOf: string;
  /** True when the last successful sync is older than the freshness limit. */
  stale: boolean;
  /** YYYY-MM-DD (Asia/Bangkok). */
  date: string;
  /** Hospital-wide visit flow of `date`; null until a sync with db/008 ran today. */
  flow: OpdFlow | null;
  clinics: ClinicWait[];
  hourly: OpdHourPoint[];
  totals: {
    waitingNow: number;
    waitingForDoctor: number;
    seenToday: number;
    /** Registration → doctor (kept for compatibility). */
    avgWaitMinutes: number | null;
    medianWaitMinutes: number | null;
    p90WaitMinutes: number | null;
    longestWaitMinutes: number;
    screenToDoctor: WaitSegment;
    doctorToRx: WaitSegment;
    longestScreenWaitMinutes: number | null;
  };
};

/** Daily OPD wait summary per clinic (PostgreSQL wait.opd_daily), also served to the central API. */
export type OpdDaily = {
  date: string;
  clinicCode: string;
  clinicName: string;
  visits: number;
  seen: number;
  avgWaitMinutes: number | null;
  medianWaitMinutes: number | null;
  p90WaitMinutes: number | null;
  /** Share of patients seen within 60 minutes of registration, 0-100. */
  within60Pct: number | null;
  /**
   * Screening → doctor / doctor → medicine of the day. null for days
   * finalized before db/009 that were not recomputed (--resegment).
   */
  screenToDoctor: WaitSegment | null;
  doctorToRx: WaitSegment | null;
  finalized: boolean;
};
