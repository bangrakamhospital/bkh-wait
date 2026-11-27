// Shared contract for the OPD "waiting to see a doctor" board, between the
// data layer (scripts/lib/hosxp-opd.mjs + src/lib/opd/*, owned by sr) and the
// UI (src/components/opd/*, src/app/opd/*, owned by jr). Aggregate numbers
// only — never HN, VN, names, queue numbers tied to a person.

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
};

/** Hourly arrivals / seen for today's curve (Asia/Bangkok hours 0-23). */
export type OpdHourPoint = {
  hour: number;
  arrived: number;
  seen: number;
  avgWaitMinutes: number | null;
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
    avgWaitMinutes: number | null;
    medianWaitMinutes: number | null;
    longestWaitMinutes: number;
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
  finalized: boolean;
};
