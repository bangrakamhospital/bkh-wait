// HOSxP (read-only) queries + aggregation for the OPD "waiting to see a
// doctor" board, used ONLY by the OPD sync worker (scripts/sync-opd.mjs).
// Connection / error handling: scripts/lib/hosxp.mjs. Aggregates only, with
// ONE exception (same pattern as the bed HN, db/006): the waiters of today
// (header "Waiters"). fetchVisits keeps the VN in memory as the join key
// for that lookup only; fetchWaiterDetails returns the HN + queue number of
// the visits waiting now, which the worker writes ONLY to the restricted
// table wait.opd_waiter (db/010, readable solely through the audited
// function wait.opd_waiters_for_clinic). VN / HN are never logged, printed
// or written anywhere else; no names / CID / address / phone are selected.
// The doctor code is only counted (COUNT DISTINCT) in SQL.
//
// Waiters (listWaiters, verified on HOSxP 2026-11-27): exactly the visits
// the board counts in waitingNow per clinic (same router + waitState), plus
// stale ones (registered > STALE_WAIT_MINUTES ago, otherwise the same
// conditions; flagged stale, NOT in the board counts): mostly visits left
// at a screening point without being closed. Per visit:
//   stage         'doctor' = counted in waitingForDoctor, else 'screening'
//   queue no.     ovst.oqueue (unique per day, filled for every visit)
//   labPending    a lab_head of the visit with confirm_report <> 'Y' and
//                 not rejected (lab_perform_status_id 3)
//   xrayOrdered   an xray_report of the visit not cancelled (status 4);
//                 HOSxP here keeps every request at status 2 "รออ่านฟิล์ม"
//                 with no examined / report time, so "done" is unknown
//   minutes       since registration / since screening, at the sync time
//                 (HOSxP clock), as the board's longest waits
//
// Definitions (verified with db-cli on HOSxP, 2026-10-29 .. 2026-11-26):
// - Visit: ovst row of the day (vstdate). Registration = vstdate + vsttime
//   (= the OPD-NEW-VISIT step of ovst_service_time, mean difference 0 min).
//   VN = Buddhist-era YYMMDD + time, so a day's VNs are the range
//   [yyMMdd, next day's yyMMdd) — verified for every visit of 2026-10/11;
//   used to range-scan ovst_service_time (index ix_vn).
// - ER: visits with main_dep '011' are left out of the per-clinic board (ER
//   triage, not an OPD queue); they are counted in the visit flow.
// - Steps (ovst_service_time.ovst_service_time_type_code):
//     OPD-NEW-VISIT  registration (depcode 023 medical records / 060 insurance / PCU)
//     OPD-SCREEN     screening, vital signs (061 general, 062 NCD, 020 psych, ...)
//     OPD-DOCTOR     doctor exam room screen opened (begin) / closed (end)
//   Rows are written in real time (update_datetime - begin: a few minutes).
// - Clinic = depcode where doctor exams happen: every depcode with an
//   OPD-DOCTOR row in the last ROUTE_DAYS days minus NON_DOCTOR_DEPS
//   (physiotherapy 027 and the screening points also use the OPD-DOCTOR
//   screen; ER / IPD are not OPD clinics).
// - Doctor exam start = earliest OPD-DOCTOR begin of the visit at a clinic.
//   Wait = doctor exam start - registration (negative -> 0). Waits above
//   MAX_WAIT_MINUTES (screen opened on a later day) are kept out of the
//   statistics but the visit still counts as seen.
// - Route: department -> the clinic where most of its visits saw a doctor
//   in the last ROUTE_DAYS days, only when >= ROUTE_MIN_SHARE of its visits
//   saw a doctor at all (061 -> 001, 062 -> 047, 020 -> 064, 032 -> 030 ...;
//   lab-only 007, dental 008, eye 018 have none: those visits normally
//   never see a doctor).
// - Route needs >= ROUTE_MIN_VISITS visits in the window (odd one-off
//   main_dep codes get none). Queue clinic = a clinic that is the target of
//   some route.
// - Clinic of a visit not seen yet: live = cur_dep if it is a queue clinic,
//   else route(cur_dep), else route(main_dep); closed day = route(main_dep)
//   (cur_dep is 999 home by then). None -> not on the board.
// - Waiting now: today, a clinic, no doctor exam start, not admitted
//   (ovst.an empty), cur_dep not in DONE_DEPS (pharmacy / cashier / home /
//   IPD / ER: left the doctor queue without an OPD-DOCTOR row), registered
//   <= STALE_WAIT_MINUTES ago (older = stale: left or screen never opened;
//   only 4 of 2566 NCD visits in 4 weeks waited longer than 8 h).
//   waitingForDoctor = waiting and (screened, or cur_dep = the clinic).
// - Seen last hour = doctor exam starts in the last 60 min (HOSxP clock);
//   doctors active = distinct ovst_service_time.doctor with an OPD-DOCTOR
//   row at the clinic in the last 60 min.
// - estimatedWaitMinutes = ceil(waitingNow * 60 / seenLastHour), capped at
//   STALE_WAIT_MINUTES: time to clear the current queue at the pace of the
//   last hour (all doctors together); null when nobody was seen in the
//   last hour (no doctor working now = unknown). The board derives the
//   same estimate from waitingForDoctor too (wait after screening).
//
// Wait segments (the way auditors measure them; verified on HOSxP
// 2026-11-20 .. 2026-11-27, docs/api.md "Wait segments"):
//   screen time   the LATEST OPD-SCREEN service_begin_datetime at or before
//                 the doctor exam start (not seen yet: the latest one). The
//                 opdscreen table is no use: begintime / endtime / outtime
//                 are empty in every row, update_datetime is the last edit.
//                 Screening takes a median 3 min (begin -> end) and the end
//                 is often re-saved after the doctor, so begin is the
//                 stable stamp.
//   doctor time   the first OPD-DOCTOR row at a clinic (as above): begin =
//                 exam start, end = exam screen closed (median 1-4 min
//                 later; missing end -> begin).
//   medicine      the earliest rx_dispenser_detail.rx_dispenser_datetime
//                 of rx_dispenser_type_id 4 "ผู้จ่ายยา" (pharmacist who
//                 handed the drugs over, depcode 013). Types 1 (prescription
//                 keyed in at the pharmacy) / 2 (prepared) / 3 (checked) are
//                 earlier steps. The visit is mostly sent home in the same
//                 minute (opd_dep_queue 999). rx_operator.pay / call_time,
//                 ovst_rx_queue, rx_queue_dispense, ovst_queue_server_* and
//                 opitemrece_pay are empty here.
//   screenToDoctor = doctor exam start - screen time (seen visits)
//   doctorToRx     = medicine - doctor exam end (seen visits with a drug
//                    item: opitemrece JOIN drugitems)
//   Negative or > SEGMENT_MAX_MINUTES values are left out of the statistics
//   and counted (screenExcluded / rxExcluded).
//   longestScreenWait = longest (now - screen time) among the visits
//   waiting now that were screened (<= STALE_WAIT_MINUTES), null if none.
//
// Visit flow (classifyFlow, verified on HOSxP 2026-11-24 .. 2026-11-27):
// EVERY ovst row of the day (ER included) = COUNT(*) FROM ovst WHERE
// vstdate = d, the bkh-kpi "visit ผู้ป่วยนอก" number, goes into exactly ONE
// bucket, first match wins:
//   admit         ovst.an set, or cur_dep 010 (IPD)
//   er            main_dep 011 or cur_dep 011 (ER visit, whatever its state)
//   done          cur_dep 999 (sent home)
//   pharmacy      cur_dep 013 pharmacy / 014 cashier. A visit stays here
//                 until staff send it home, also after the drugs were
//                 handed over (rx_dispenser_detail type 4, wait segments).
//   screening     the board's waitingNow minus waitingForDoctor (not seen,
//                 not screened, not in front of the clinic room)
//   doctor        the board's waitingForDoctor (not seen, screened or at the
//                 clinic room); includes those sent to lab / X-ray before the
//                 doctor (they come back to the same queue)
//   after_doctor  doctor exam recorded and cur_dep still at an OPD point
//                 (clinic room / screening point / registration): waiting
//                 for lab results, an appointment, papers ...
//   lab           cur_dep 007 lab / 006 X-ray (mostly lab-only visits:
//                 main_dep 007, no screening, no doctor, ~30 % of a day)
//   services      cur_dep at any other department: dental 008/057/066,
//                 eye 018, physio 027, Thai medicine 029, special clinics
//                 without a doctor queue ...
//   other         the rest: not seen and at an OPD point but stale (> 8 h)
//                 or with no route, or cur_dep empty
// OPD point = a queue clinic (route target), a route source department, or
// registration (023 medical records / 060 insurance).

export const ROUTE_DAYS = 28;
export const ROUTE_MIN_SHARE = 0.5;
export const ROUTE_MIN_VISITS = 5;
export const STALE_WAIT_MINUTES = 480;
export const MAX_WAIT_MINUTES = 720;
/** Segment waits above this (or negative) are impossible / stale: excluded and counted. */
export const SEGMENT_MAX_MINUTES = 480;
/** rx_dispenser_type_id of the pharmacist who handed the drugs over (ผู้จ่ายยา). */
export const RX_DISPENSE_TYPE = 4;
export const ER_DEP = "011";
/** Departments that are not doctor-exam clinics even with OPD-DOCTOR rows. */
export const NON_DOCTOR_DEPS = [
  "006", // X-ray
  "007", // lab
  "010", // IPD
  "011", // ER
  "013", // pharmacy
  "014", // cashier
  "020", // psych screening point
  "023", // medical records
  "027", // physiotherapy
  "060", // insurance
  "061", // general screening point
  "062", // NCD screening point
  "999", // home
];
/** cur_dep values that mean the visit left the doctor queue. */
export const DONE_DEPS = new Set(["010", "011", "013", "014", "999"]);
export const IPD_DEP = "010";
export const HOME_DEP = "999";
export const PHARMACY_DEPS = new Set(["013", "014"]);
export const REGISTRATION_DEPS = ["023", "060"];
export const LAB_DEPS = new Set(["006", "007"]);
/** Visit-flow buckets in display order; also the CHECK list of db/008. */
export const FLOW_BUCKETS = [
  "screening", "doctor", "after_doctor", "lab", "services", "pharmacy", "done", "er", "admit", "other",
];

const NON_DOCTOR_CSV = NON_DOCTOR_DEPS.join(",");
const num = (v) => Number(v ?? 0);
const code = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** "YYYY-MM-DD" -> VN prefix (Buddhist-era yyMMdd). */
export function vnPrefix(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${String((y + 543) % 100).padStart(2, "0")}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" + n days. */
export function addDays(date, n) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** HOSxP local "YYYY-MM-DD HH:MM:SS" (+07) -> epoch ms. */
export function hisMs(s) {
  return new Date(`${String(s).replace(" ", "T")}+07:00`).getTime();
}

/** kskdepartment names without the leading "NNN-" (all departments). */
export async function fetchDepartmentNames(his) {
  const rows = await his.query("SELECT depcode, department FROM kskdepartment");
  const out = new Map();
  for (const r of rows) {
    const c = code(r.depcode);
    if (!c) continue;
    const name = String(r.department ?? "").trim().replace(/^\d{2,3}\s*-\s*/, "");
    out.set(c, name || `แผนก ${c}`);
  }
  return out;
}

// First OPD-DOCTOR row per visit at a clinic, for the visits of [lo, hi).
// MariaDB runs it as a LATERAL DERIVED table on ix_vn (EXPLAIN checked).
const FIRST_DOCTOR = `
  SELECT t.vn, t.depcode, t.service_begin_datetime AS b, t.service_end_datetime AS e,
         ROW_NUMBER() OVER (PARTITION BY t.vn ORDER BY t.service_begin_datetime, t.ovst_service_time_id) AS rn
    FROM ovst_service_time t
   WHERE t.vn >= :lo AND t.vn < :hi
     AND t.ovst_service_time_type_code = 'OPD-DOCTOR'
     AND t.service_begin_datetime IS NOT NULL
     AND t.depcode IS NOT NULL
     AND NOT FIND_IN_SET(t.depcode, :nonDoctor)`;

/**
 * Clinics + routes from the ROUTE_DAYS days before `today`.
 * -> { clinics: Map<code, firstDoctorVisits>, routes: [{ fromDep, clinicCode, visits, share }] }
 */
export async function fetchRoutes(his, today) {
  const from = addDays(today, -ROUTE_DAYS);
  const rows = await his.query(
    `SELECT o.main_dep, d.depcode AS doc_dep, COUNT(*) AS n
       FROM ovst o
       LEFT JOIN (${FIRST_DOCTOR}) d ON d.vn = o.vn AND d.rn = 1
      WHERE o.vstdate >= :from AND o.vstdate < :today
        AND (o.main_dep IS NULL OR o.main_dep <> :er)
      GROUP BY o.main_dep, d.depcode`,
    { from, today, lo: vnPrefix(from), hi: vnPrefix(today), nonDoctor: NON_DOCTOR_CSV, er: ER_DEP },
  );
  const clinics = new Map();
  const byDep = new Map(); // main_dep -> { visits, seen, top: Map<clinic, n> }
  for (const r of rows) {
    const dep = code(r.main_dep);
    const doc = code(r.doc_dep);
    const n = num(r.n);
    if (doc) clinics.set(doc, (clinics.get(doc) ?? 0) + n);
    if (!dep) continue;
    const e = byDep.get(dep) ?? { visits: 0, seen: 0, top: new Map() };
    e.visits += n;
    if (doc) {
      e.seen += n;
      e.top.set(doc, (e.top.get(doc) ?? 0) + n);
    }
    byDep.set(dep, e);
  }
  const routes = [];
  for (const [dep, e] of byDep) {
    if (e.visits < ROUTE_MIN_VISITS || e.seen / e.visits < ROUTE_MIN_SHARE) continue;
    const [best] = [...e.top].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    routes.push({ fromDep: dep, clinicCode: best[0], visits: e.visits, share: Math.round((e.seen / e.visits) * 10_000) / 10_000 });
  }
  routes.sort((a, b) => a.fromDep.localeCompare(b.fromDep));
  return { clinics, routes };
}

/**
 * One row per visit of `date` — ALL ovst rows of the day, ER included
 * (er = true; the per-clinic board skips them) — coded fields only:
 * { vn (in-memory join key, never output), regMs, mainDep, curDep, er, admitted, screened, docDep, docMs,
 *   docEndMs, scrMs, rxMs, hasRx } (wait segments: see header).
 */
export async function fetchVisits(his, date) {
  const rows = await his.query(
    `SELECT o.vn, TIMESTAMP(o.vstdate, o.vsttime) AS reg_at, o.main_dep, o.cur_dep,
            (o.an IS NOT NULL AND o.an <> '') AS admitted,
            EXISTS (SELECT 1 FROM ovst_service_time s
                     WHERE s.vn = o.vn AND s.ovst_service_time_type_code = 'OPD-SCREEN') AS screened,
            d.depcode AS doc_dep, d.b AS doc_at, d.e AS doc_end,
            (SELECT MAX(s.service_begin_datetime) FROM ovst_service_time s
              WHERE s.vn = o.vn AND s.ovst_service_time_type_code = 'OPD-SCREEN'
                AND (d.b IS NULL OR s.service_begin_datetime <= d.b)) AS scr_at,
            (SELECT MIN(x.rx_dispenser_datetime) FROM rx_dispenser_detail x
              WHERE x.vn = o.vn AND x.rx_dispenser_type_id = :rxType) AS rx_at,
            EXISTS (SELECT 1 FROM opitemrece r JOIN drugitems di ON di.icode = r.icode
                     WHERE r.vn = o.vn) AS has_rx
       FROM ovst o
       LEFT JOIN (${FIRST_DOCTOR}) d ON d.vn = o.vn AND d.rn = 1
      WHERE o.vstdate = :d`,
    { d: date, lo: vnPrefix(date), hi: vnPrefix(addDays(date, 1)), nonDoctor: NON_DOCTOR_CSV, rxType: RX_DISPENSE_TYPE },
  );
  return rows.map((r) => ({
    // join key for fetchWaiterDetails only: never log, print or store it
    vn: code(r.vn),
    regMs: r.reg_at ? hisMs(r.reg_at) : null,
    mainDep: code(r.main_dep),
    curDep: code(r.cur_dep),
    er: code(r.main_dep) === ER_DEP,
    admitted: num(r.admitted) === 1,
    screened: num(r.screened) === 1,
    docDep: code(r.doc_dep) || null,
    docMs: r.doc_at ? hisMs(r.doc_at) : null,
    docEndMs: r.doc_end ? hisMs(r.doc_end) : null,
    scrMs: r.scr_at ? hisMs(r.scr_at) : null,
    rxMs: r.rx_at ? hisMs(r.rx_at) : null,
    hasRx: num(r.has_rx) === 1,
  }));
}

/** COUNT(*) FROM ovst of `date` (dry-run cross-check of the flow total). */
export async function fetchVisitCount(his, date) {
  const [r] = await his.query("SELECT COUNT(*) AS n FROM ovst WHERE vstdate = :d", { d: date });
  return num(r?.n);
}

/** Distinct doctors with an OPD-DOCTOR row per clinic in the last 60 min (today's visits). */
export async function fetchDoctorsActive(his, date) {
  const rows = await his.query(
    `SELECT t.depcode, COUNT(DISTINCT t.doctor) AS n
       FROM ovst_service_time t
      WHERE t.vn >= :lo AND t.vn < :hi
        AND t.ovst_service_time_type_code = 'OPD-DOCTOR'
        AND t.service_begin_datetime >= NOW() - INTERVAL 60 MINUTE
        AND t.doctor IS NOT NULL AND t.doctor <> ''
      GROUP BY t.depcode`,
    { lo: vnPrefix(date), hi: vnPrefix(addDays(date, 1)) },
  );
  return new Map(rows.map((r) => [code(r.depcode), num(r.n)]));
}

// ---------------------------------------------------------------------------
// Aggregation (pure).
// ---------------------------------------------------------------------------

const round1 = (x) => Math.round(x * 10) / 10;

/** Nearest-rank percentile of a sorted array (null when empty). */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** Median (mean of the two middle values for even counts), null when empty. */
export function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** avg / median / p90 / within60 over sorted wait minutes. */
export function waitStats(sorted) {
  if (sorted.length === 0) return { avg: null, median: null, p90: null, within60: null };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: round1(sum / sorted.length),
    median: round1(median(sorted)),
    p90: round1(percentile(sorted, 0.9)),
    within60: round1((sorted.filter((m) => m <= 60).length / sorted.length) * 100),
  };
}

const bkkHour = (ms) => new Date(ms + 7 * 3_600_000).getUTCHours();

/**
 * Per-clinic aggregates of one day.
 *   visits: fetchVisits rows; clinicSet: Set of clinic codes;
 *   route: Map from_dep -> clinic; nowMs: HOSxP now (live) or null (closed day)
 * -> Map clinic -> emptyAgg() shape (see there)
 */
export function aggregateDay(visits, clinicSet, route, nowMs) {
  const out = new Map();
  const get = (c) => {
    let e = out.get(c);
    if (!e) {
      e = emptyAgg();
      out.set(c, e);
    }
    return e;
  };
  const r = router(clinicSet, route);

  for (const v of visits) {
    // ER visits and rows without a registration time are not on the board
    if (v.er || v.regMs === null) continue;
    if (isSeen(v, clinicSet)) {
      const e = get(v.docDep);
      e.visits += 1;
      e.seen += 1;
      e.hourly[bkkHour(v.regMs)].arrived += 1;
      const h = e.hourly[bkkHour(v.docMs)];
      h.seen += 1;
      const wait = Math.max(0, Math.round((v.docMs - v.regMs) / 60_000));
      if (wait <= MAX_WAIT_MINUTES) {
        e.waits.push(wait);
        h.waitSum += wait;
        h.waitN += 1;
      }
      // screening -> doctor exam start
      if (v.scrMs !== null) {
        const m = segmentMinutes(v.scrMs, v.docMs);
        if (m === null) e.screenExcluded += 1;
        else {
          e.screenWaits.push(m);
          h.screenSum += m;
          h.screenN += 1;
        }
      }
      // doctor exam end -> medicine handed over (visits with a drug item)
      if (v.hasRx) {
        e.seenWithRx += 1;
        if (v.rxMs !== null) {
          const m = segmentMinutes(v.docEndMs ?? v.docMs, v.rxMs);
          if (m === null) e.rxExcluded += 1;
          else e.rxWaits.push(m);
        }
      }
      if (nowMs !== null && v.docMs >= nowMs - 3_600_000 && v.docMs <= nowMs + 60_000) e.seenLastHour += 1;
      continue;
    }
    // Not seen (yet). Live: where is the patient now; closed day: where they were headed.
    const clinic = nowMs !== null ? r.liveClinic(v) : r.routeOf(v.mainDep);
    if (!clinic) continue;
    const e = get(clinic);
    e.visits += 1;
    e.hourly[bkkHour(v.regMs)].arrived += 1;
    if (nowMs === null) continue;
    const w = waitState(v, clinic, nowMs);
    if (!w) continue;
    e.waitingNow += 1;
    if (w.forDoctor) e.waitingForDoctor += 1;
    e.longestWait = Math.max(e.longestWait, w.age);
    if (v.scrMs !== null) {
      const since = Math.round((nowMs - v.scrMs) / 60_000);
      if (since >= 0 && since <= STALE_WAIT_MINUTES) e.longestScreenWait = Math.max(e.longestScreenWait ?? 0, since);
    }
  }
  for (const e of out.values()) {
    e.waits.sort((a, b) => a - b);
    e.screenWaits.sort((a, b) => a - b);
    e.rxWaits.sort((a, b) => a - b);
  }
  return out;
}

/**
 * Empty per-clinic aggregate: { visits, seen, waits (registration -> doctor,
 * sorted), waitingNow, waitingForDoctor, longestWait, seenLastHour,
 * screenWaits / rxWaits (segments, sorted), screenExcluded / rxExcluded,
 * seenWithRx, longestScreenWait (null = nobody screened is waiting),
 * hourly: 24 x { arrived, seen, waitSum, waitN, screenSum, screenN } }.
 */
export function emptyAgg() {
  return {
    visits: 0, seen: 0, waits: [], waitingNow: 0, waitingForDoctor: 0, longestWait: 0, seenLastHour: 0,
    screenWaits: [], screenExcluded: 0, rxWaits: [], rxExcluded: 0, seenWithRx: 0, longestScreenWait: null,
    hourly: Array.from({ length: 24 }, () => ({ arrived: 0, seen: 0, waitSum: 0, waitN: 0, screenSum: 0, screenN: 0 })),
  };
}

/** Whole minutes from -> to, or null when negative or > SEGMENT_MAX_MINUTES. */
function segmentMinutes(fromMs, toMs) {
  const m = Math.round((toMs - fromMs) / 60_000);
  return m < 0 || m > SEGMENT_MAX_MINUTES ? null : m;
}

/** Seen by a doctor at a clinic (the board's definition). */
function isSeen(v, clinicSet) {
  return Boolean(v.docDep && v.docMs !== null && clinicSet.has(v.docDep));
}

/** Clinic lookups shared by aggregateDay and classifyFlow. */
function router(clinicSet, route) {
  const routeOf = (dep) => (dep && route.has(dep) && clinicSet.has(route.get(dep)) ? route.get(dep) : null);
  // Queue clinics = clinics some department is routed to. A clinic that is
  // no route target (e.g. eye 018: a few doctor exams, mostly not) never
  // collects not-yet-seen visits just because they sit in its department.
  const targets = new Set([...route.values()].filter((c) => clinicSet.has(c)));
  const asClinic = (dep) => (targets.has(dep) ? dep : null);
  /** Live clinic of a not-yet-seen visit: where the patient is now, or is headed. */
  const liveClinic = (v) => asClinic(v.curDep) ?? routeOf(v.curDep) ?? routeOf(v.mainDep);
  return { routeOf, liveClinic, targets };
}

/**
 * Live waiting state of a not-yet-seen visit headed to `clinic`: null (not
 * waiting: admitted, left the doctor queue, or stale) or { age, forDoctor }.
 */
function waitState(v, clinic, nowMs) {
  const age = Math.round((nowMs - v.regMs) / 60_000);
  if (v.admitted || DONE_DEPS.has(v.curDep) || age < 0 || age > STALE_WAIT_MINUTES) return null;
  return { age, forDoctor: v.screened || v.curDep === clinic };
}

/**
 * Where every visit of the day is now (header "Visit flow").
 *   visits: fetchVisits rows (all rows of the day); nowMs: HOSxP now
 * -> { total, counts: { [bucket]: n } }, sum(counts) === total === visits.length
 */
export function classifyFlow(visits, clinicSet, route, nowMs) {
  const r = router(clinicSet, route);
  const opdPoints = new Set([...r.targets, ...route.keys(), ...REGISTRATION_DEPS]);
  const bucketOf = (v) => {
    if (v.admitted || v.curDep === IPD_DEP) return "admit";
    if (v.er || v.curDep === ER_DEP) return "er";
    if (v.curDep === HOME_DEP) return "done";
    if (PHARMACY_DEPS.has(v.curDep)) return "pharmacy";
    const seen = isSeen(v, clinicSet);
    if (!seen && v.regMs !== null) {
      const clinic = r.liveClinic(v);
      const w = clinic ? waitState(v, clinic, nowMs) : null;
      if (w) return w.forDoctor ? "doctor" : "screening";
    }
    if (!v.curDep) return "other";
    if (LAB_DEPS.has(v.curDep)) return "lab";
    if (!opdPoints.has(v.curDep)) return "services";
    return seen ? "after_doctor" : "other";
  };
  const counts = Object.fromEntries(FLOW_BUCKETS.map((k) => [k, 0]));
  // bucket -> cur_dep -> n (department codes only; dry-run report)
  const byDep = Object.fromEntries(FLOW_BUCKETS.map((k) => [k, {}]));
  for (const v of visits) {
    const b = bucketOf(v);
    counts[b] += 1;
    const d = v.curDep || "-";
    byDep[b][d] = (byDep[b][d] ?? 0) + 1;
  }
  const total = visits.length;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (sum !== total) throw new Error(`flow buckets sum ${sum} != total ${total}`);
  return { total, counts, byDep };
}

/**
 * Visits waiting now per clinic (header "Waiters"), live only. Non-stale
 * rows are exactly the board's waitingNow (stage 'doctor' = its
 * waitingForDoctor); stale rows are the same conditions past
 * STALE_WAIT_MINUTES. -> [{ vn, clinic, stage, stale, regMs, scrMs, curDep,
 * minutesSinceRegistration, minutesSinceScreening }] (vn: join key only).
 */
export function listWaiters(visits, clinicSet, route, nowMs) {
  const r = router(clinicSet, route);
  const out = [];
  for (const v of visits) {
    if (v.er || v.regMs === null || isSeen(v, clinicSet)) continue;
    const clinic = r.liveClinic(v);
    if (!clinic) continue;
    let w = waitState(v, clinic, nowMs);
    let stale = false;
    if (!w) {
      // stale: everything of waitState except the age limit
      const age = Math.round((nowMs - v.regMs) / 60_000);
      if (v.admitted || DONE_DEPS.has(v.curDep) || age <= STALE_WAIT_MINUTES) continue;
      w = { age, forDoctor: v.screened || v.curDep === clinic };
      stale = true;
    }
    out.push({
      vn: v.vn,
      clinic,
      stage: w.forDoctor ? "doctor" : "screening",
      stale,
      regMs: v.regMs,
      scrMs: v.scrMs,
      curDep: v.curDep || null,
      minutesSinceRegistration: w.age,
      minutesSinceScreening: v.scrMs === null ? null : Math.max(0, Math.round((nowMs - v.scrMs) / 60_000)),
    });
  }
  return out;
}

/**
 * RESTRICTED: HN, queue number and lab / X-ray state of the given visits
 * (header "Waiters"). Only for wait.opd_waiter; never log or print the
 * result. -> Map vn -> { hn, oqueue, labPending, xrayOrdered }
 */
export async function fetchWaiterDetails(his, vns) {
  const out = new Map();
  for (let i = 0; i < vns.length; i += 500) {
    const chunk = vns.slice(i, i + 500);
    // execute() has no array expansion: one named placeholder per VN
    const params = Object.fromEntries(chunk.map((vn, j) => [`v${j}`, vn]));
    const rows = await his.query(
      `SELECT o.vn, o.hn, o.oqueue,
              EXISTS (SELECT 1 FROM lab_head h
                       WHERE h.vn = o.vn AND coalesce(h.confirm_report, 'N') <> 'Y'
                         AND coalesce(h.lab_perform_status_id, 0) <> 3) AS lab_pending,
              EXISTS (SELECT 1 FROM xray_report x
                       WHERE x.vn = o.vn AND coalesce(x.xray_status_id, 0) <> 4) AS xray_ordered
         FROM ovst o
        WHERE o.vn IN (${chunk.map((_, j) => `:v${j}`).join(", ")})`,
      params,
    );
    for (const r of rows) {
      const hn = code(r.hn);
      if (!hn) continue;
      out.set(code(r.vn), {
        hn,
        oqueue: r.oqueue === null || r.oqueue === undefined ? null : num(r.oqueue),
        labPending: num(r.lab_pending) === 1,
        xrayOrdered: num(r.xray_ordered) === 1,
      });
    }
  }
  return out;
}

/** Rough wait for a patient arriving now (see header). */
export function estimateWait(waitingNow, seenLastHour) {
  if (seenLastHour <= 0) return null;
  return Math.min(STALE_WAIT_MINUTES, Math.ceil((waitingNow * 60) / seenLastHour));
}
