// RESTRICTED contract: the OPD visits waiting now in one clinic, with HN.
// Only returned by the authenticated staff endpoint GET /api/opd/waiters
// (every call audit-logged by wait.opd_waiters_for_clinic, db/010). Never
// in the public board (src/lib/opd/types.ts stays aggregate-only), the
// central API (/api/v1/*), logs, storage, labels or tooltips.

/** 'screening' = รอซักประวัติ/คัดกรอง, 'doctor' = รอพบแพทย์ (screened or at the clinic room). */
export type OpdWaiterStage = "screening" | "doctor";

export type OpdWaiter = {
  hn: string;
  /** HOSxP queue number of the day (ovst.oqueue); null when missing. */
  queueNo: number | null;
  stage: OpdWaiterStage;
  /** Registered more than 8 h ago: not in the board counts (probably left without the visit being closed). */
  stale: boolean;
  /** ISO times. */
  registeredAt: string;
  screenedAt: string | null;
  /** Minutes at the sync time (asOf). */
  minutesSinceRegistration: number;
  minutesSinceScreening: number | null;
  /** HOSxP department the visit is at now (cur_dep) and its name. */
  curDep: string | null;
  curDepName: string | null;
  /** A lab order without a confirmed report. */
  labPending: boolean;
  /** An X-ray request (not cancelled). */
  xrayOrdered: boolean;
};

/** Body of GET /api/opd/waiters?clinic= */
export type ClinicWaiters = {
  clinicCode: string;
  clinicName: string;
  /** ISO time of the OPD sync the list comes from. */
  asOf: string;
  /** Longest wait first; stale rows last. */
  waiters: OpdWaiter[];
};
