// HOSxP (read-only) queries + aggregation for the OPD "waiting to see a
// doctor" board, used ONLY by the OPD sync worker (scripts/sync-opd.mjs).
// Connection / error handling: scripts/lib/hosxp.mjs. Nothing that
// identifies a patient leaves the SQL: no VN / HN / names are selected
// (VN is used only inside the queries as the join key), and the doctor
// code is only counted (COUNT DISTINCT) in SQL.
//
// Definitions (verified with db-cli on HOSxP, 2026-10-29 .. 2026-11-26):
// - Visit: ovst row of the day (vstdate). Registration = vstdate + vsttime
//   (= the OPD-NEW-VISIT step of ovst_service_time, mean difference 0 min).
//   VN = Buddhist-era YYMMDD + time, so a day's VNs are the range
//   [yyMMdd, next day's yyMMdd) — verified for every visit of 2026-10/11;
//   used to range-scan ovst_service_time (index ix_vn).
// - ER: visits with main_dep '011' are left out (ER triage, not an OPD queue).
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
//   last hour (no doctor working now = unknown).

export const ROUTE_DAYS = 28;
export const ROUTE_MIN_SHARE = 0.5;
export const ROUTE_MIN_VISITS = 5;
export const STALE_WAIT_MINUTES = 480;
export const MAX_WAIT_MINUTES = 720;
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
  SELECT t.vn, t.depcode, t.service_begin_datetime AS b,
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
 * One row per visit of `date` (ER visits excluded), coded fields only:
 * { regMs, mainDep, curDep, admitted, screened, docDep, docMs }.
 */
export async function fetchVisits(his, date) {
  const rows = await his.query(
    `SELECT TIMESTAMP(o.vstdate, o.vsttime) AS reg_at, o.main_dep, o.cur_dep,
            (o.an IS NOT NULL AND o.an <> '') AS admitted,
            EXISTS (SELECT 1 FROM ovst_service_time s
                     WHERE s.vn = o.vn AND s.ovst_service_time_type_code = 'OPD-SCREEN') AS screened,
            d.depcode AS doc_dep, d.b AS doc_at
       FROM ovst o
       LEFT JOIN (${FIRST_DOCTOR}) d ON d.vn = o.vn AND d.rn = 1
      WHERE o.vstdate = :d AND o.vsttime IS NOT NULL
        AND (o.main_dep IS NULL OR o.main_dep <> :er)`,
    { d: date, lo: vnPrefix(date), hi: vnPrefix(addDays(date, 1)), nonDoctor: NON_DOCTOR_CSV, er: ER_DEP },
  );
  return rows.map((r) => ({
    regMs: hisMs(r.reg_at),
    mainDep: code(r.main_dep),
    curDep: code(r.cur_dep),
    admitted: num(r.admitted) === 1,
    screened: num(r.screened) === 1,
    docDep: code(r.doc_dep) || null,
    docMs: r.doc_at ? hisMs(r.doc_at) : null,
  }));
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
 * -> Map clinic -> { visits, seen, waits(sorted), waitingNow, waitingForDoctor,
 *                    longestWait, seenLastHour, hourly: [24 x {arrived, seen, waitSum, waitN}] }
 */
export function aggregateDay(visits, clinicSet, route, nowMs) {
  const out = new Map();
  const get = (c) => {
    let e = out.get(c);
    if (!e) {
      e = {
        visits: 0, seen: 0, waits: [], waitingNow: 0, waitingForDoctor: 0, longestWait: 0, seenLastHour: 0,
        hourly: Array.from({ length: 24 }, () => ({ arrived: 0, seen: 0, waitSum: 0, waitN: 0 })),
      };
      out.set(c, e);
    }
    return e;
  };
  const routeOf = (dep) => (dep && route.has(dep) && clinicSet.has(route.get(dep)) ? route.get(dep) : null);
  // Queue clinics = clinics some department is routed to. A clinic that is
  // no route target (e.g. eye 018: a few doctor exams, mostly not) never
  // collects not-yet-seen visits just because they sit in its department.
  const targets = new Set([...route.values()].filter((c) => clinicSet.has(c)));
  const asClinic = (dep) => (targets.has(dep) ? dep : null);

  for (const v of visits) {
    if (v.docDep && v.docMs !== null && clinicSet.has(v.docDep)) {
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
      if (nowMs !== null && v.docMs >= nowMs - 3_600_000 && v.docMs <= nowMs + 60_000) e.seenLastHour += 1;
      continue;
    }
    // Not seen (yet). Live: where is the patient now; closed day: where they were headed.
    const clinic =
      nowMs !== null
        ? (asClinic(v.curDep) ?? routeOf(v.curDep) ?? routeOf(v.mainDep))
        : routeOf(v.mainDep);
    if (!clinic) continue;
    const e = get(clinic);
    e.visits += 1;
    e.hourly[bkkHour(v.regMs)].arrived += 1;
    if (nowMs === null) continue;
    const age = Math.round((nowMs - v.regMs) / 60_000);
    if (v.admitted || DONE_DEPS.has(v.curDep) || age < 0 || age > STALE_WAIT_MINUTES) continue;
    e.waitingNow += 1;
    if (v.screened || v.curDep === clinic) e.waitingForDoctor += 1;
    e.longestWait = Math.max(e.longestWait, age);
  }
  for (const e of out.values()) e.waits.sort((a, b) => a - b);
  return out;
}

/** Rough wait for a patient arriving now (see header). */
export function estimateWait(waitingNow, seenLastHour) {
  if (seenLastHour <= 0) return null;
  return Math.min(STALE_WAIT_MINUTES, Math.ceil((waitingNow * 60) / seenLastHour));
}
