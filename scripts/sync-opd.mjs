#!/usr/bin/env node
// HOSxP -> PostgreSQL sync of the OPD "waiting to see a doctor" board.
// Separate from scripts/sync-hosxp.mjs (beds, every 15 min) because the OPD
// queue changes by the minute: this job runs every 5 min during OPD hours
// (06:00-20:55), reads only today's visits (a few hundred rows, ~50 ms on
// HOSxP), and a failure here never blocks the bed sync (own advisory lock,
// own sync_run rows with job = 'opd').
//
//   node --env-file=/var/www/wait/.env.sync scripts/sync-opd.mjs
//   node --env-file=.env.sync scripts/sync-opd.mjs --dry-run [--date=YYYY-MM-DD]
//   node --env-file=.env.sync scripts/sync-opd.mjs --backfill=30
//
// Env (.env.sync, same as the bed worker): HIS_* (SELECT-only HOSxP
// account) and WAIT_SYNC_DATABASE_URL (role bkh_wait_sync).
//
// One run:
//   1. PostgreSQL: open (unfinalized) earlier days of opd_daily, the stored
//      clinic list + routes and their age
//   2. HOSxP (scripts/lib/hosxp-opd.mjs): clock, department names, clinics +
//      routes of the last 28 days (only when the stored ones are older than
//      6 h), today's visits, doctors active in the last hour, and the
//      visits of every open earlier day (to finalize it)
//   3. PostgreSQL, ONE transaction (advisory lock): his_opd_clinic,
//      opd_route (when refreshed), sync_run (job 'opd'), opd_state
//      (replaced), opd_hourly + opd_daily of today (replaced / upserted),
//      earlier open days recomputed and finalized
//   4. on failure: rollback, a sync_run row (job 'opd', ok = false, short
//      error code only), exit code 1
// Re-running is safe: every write is an upsert / replace.
//
// --dry-run: steps 1-2 without PostgreSQL (routes always read from HOSxP);
//   prints what would be written. --date=YYYY-MM-DD: report that day as a
//   closed day instead of today (verification).
// --backfill=N (1-92): also write finalized rows for the N days before
//   today that have no opd_daily rows yet (first install).

import { errCode, fetchClock, openHis, SyncError } from "./lib/hosxp.mjs";
import {
  addDays,
  aggregateDay,
  estimateWait,
  fetchDepartmentNames,
  fetchDoctorsActive,
  fetchRoutes,
  fetchVisits,
  hisMs,
  waitStats,
} from "./lib/hosxp-opd.mjs";
import { openPg, pgCode } from "./lib/pg-sync.mjs";

const LOCK_KEY = 72_517_086; // beds sync uses ...085, migrate ...084
const ROUTE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node --env-file=.env.sync scripts/sync-opd.mjs [--dry-run [--date=YYYY-MM-DD]] [--backfill=N]");
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
const dateArg = argv.find((a) => a.startsWith("--date="))?.slice(7) ?? null;
const backfillArg = argv.find((a) => a.startsWith("--backfill="))?.slice(11) ?? null;
if (dateArg !== null && (!DATE_RE.test(dateArg) || !dryRun)) {
  console.error("--date=YYYY-MM-DD is only valid with --dry-run");
  process.exit(2);
}
const backfill = backfillArg === null ? 0 : Number(backfillArg);
if (!Number.isInteger(backfill) || backfill < 0 || backfill > 92) {
  console.error("--backfill=N: N must be 1-92");
  process.exit(2);
}

const ts = () => new Date().toISOString();

/** Clinic set = clinics of the last 28 days + any clinic with a doctor exam in `visits`. */
function clinicSetOf(clinics28, ...visitLists) {
  const set = new Set(clinics28.keys());
  for (const list of visitLists) for (const v of list) if (v.docDep) set.add(v.docDep);
  return set;
}

/** Per-clinic rows of one day, ready to write. */
function dayRows(agg, names) {
  return [...agg].map(([clinic, e]) => {
    const s = waitStats(e.waits);
    return {
      clinic,
      name: names.get(clinic) ?? `แผนก ${clinic}`,
      visits: e.visits,
      seen: e.seen,
      waits: e.waits,
      ...s,
      hourly: e.hourly,
      e,
    };
  });
}

async function readHis(his, { routesStored, openDays, backfillDays }) {
  const clock = await fetchClock(his);
  const today = dateArg ?? clock.today;
  const names = await fetchDepartmentNames(his);
  const routes = routesStored ?? (await fetchRoutes(his, today));
  const visits = await fetchVisits(his, today);
  const doctors = dateArg ? new Map() : await fetchDoctorsActive(his, today);
  const closing = [];
  for (const day of new Set([...openDays, ...backfillDays])) {
    if (day < clock.today) closing.push({ day, visits: await fetchVisits(his, day) });
  }
  return { clock, today, names, routes, routesFresh: routesStored === null, visits, doctors, closing };
}

function summarize(h) {
  const nowMs = dateArg ? null : hisMs(h.clock.now);
  const clinicSet = clinicSetOf(h.routes.clinics, h.visits, ...h.closing.map((c) => c.visits));
  const route = new Map(h.routes.routes.map((r) => [r.fromDep, r.clinicCode]));
  const todayAgg = aggregateDay(h.visits, clinicSet, route, nowMs);
  for (const c of clinicSet) if (!todayAgg.has(c)) todayAgg.set(c, emptyAgg());
  const today = dayRows(todayAgg, h.names).map((r) => ({
    ...r,
    doctorsActive: h.doctors.get(r.clinic) ?? 0,
    estimatedWait: nowMs === null ? null : estimateWait(r.e.waitingNow, r.e.seenLastHour),
  }));
  const closing = h.closing.map((c) => ({
    day: c.day,
    rows: dayRows(aggregateDay(c.visits, clinicSet, route, null), h.names),
  }));
  return { nowMs, clinicSet, today, closing };
}

function emptyAgg() {
  return {
    visits: 0, seen: 0, waits: [], waitingNow: 0, waitingForDoctor: 0, longestWait: 0, seenLastHour: 0,
    hourly: Array.from({ length: 24 }, () => ({ arrived: 0, seen: 0, waitSum: 0, waitN: 0 })),
  };
}

function dryRunReport(h, s) {
  const all = s.today.flatMap((r) => r.waits).sort((a, b) => a - b);
  const sum = (k) => s.today.reduce((n, r) => n + r.e[k], 0);
  return {
    dryRun: true,
    hisClock: h.clock,
    date: h.today,
    mode: s.nowMs === null ? "closed day" : "live",
    visitsRead: h.visits.length,
    clinics: s.today
      .filter((r) => r.visits > 0 || r.e.waitingNow > 0)
      .sort((a, b) => b.visits - a.visits)
      .map((r) => ({
        clinic: r.clinic,
        name: r.name,
        visits: r.visits,
        seen: r.seen,
        waitingNow: r.e.waitingNow,
        waitingForDoctor: r.e.waitingForDoctor,
        longestWait: r.e.longestWait,
        seenLastHour: r.e.seenLastHour,
        doctorsActive: r.doctorsActive,
        estimatedWait: r.estimatedWait,
        avg: r.avg,
        median: r.median,
        p90: r.p90,
        within60Pct: r.within60,
      })),
    totals: {
      visits: sum("visits"),
      seen: sum("seen"),
      waitingNow: sum("waitingNow"),
      waitingForDoctor: sum("waitingForDoctor"),
      ...waitStats(all),
    },
    hourly: Array.from({ length: 24 }, (_, hour) => {
      let arrived = 0, seen = 0, ws = 0, wn = 0;
      for (const r of s.today) {
        const x = r.hourly[hour];
        arrived += x.arrived; seen += x.seen; ws += x.waitSum; wn += x.waitN;
      }
      return { hour, arrived, seen, avgWait: wn ? Math.round((ws / wn) * 10) / 10 : null };
    }).filter((x) => x.arrived || x.seen),
    clinicSet: [...s.clinicSet].sort(),
    routes: h.routes.routes,
    wouldFinalize: s.closing.map((c) => ({
      day: c.day,
      clinics: c.rows.filter((r) => r.visits > 0).map((r) => ({ clinic: r.clinic, visits: r.visits, seen: r.seen, median: r.median })),
    })),
  };
}

async function readPgState(client) {
  const open = await client.query(
    "SELECT DISTINCT visit_date::text AS d FROM opd_daily WHERE finalized_at IS NULL ORDER BY 1",
  );
  const routeAge = await client.query("SELECT max(computed_at) AS at, count(*)::int AS n FROM opd_route");
  const at = routeAge.rows[0]?.at;
  let routesStored = null;
  if (at && Date.now() - new Date(at).getTime() <= ROUTE_MAX_AGE_MS) {
    const r = await client.query("SELECT from_dep, clinic_code, visits, seen_share FROM opd_route");
    const c = await client.query("SELECT clinic_code, visits_28d FROM his_opd_clinic WHERE active");
    routesStored = {
      clinics: new Map(c.rows.map((x) => [x.clinic_code, Number(x.visits_28d)])),
      routes: r.rows.map((x) => ({ fromDep: x.from_dep, clinicCode: x.clinic_code, visits: Number(x.visits), share: Number(x.seen_share) })),
    };
  }
  let backfillDays = [];
  if (backfill > 0) {
    const have = await client.query("SELECT DISTINCT visit_date::text AS d FROM opd_daily WHERE visit_date >= current_date - $1::int", [backfill]);
    const got = new Set(have.rows.map((x) => x.d));
    const todayPg = (await client.query("SELECT current_date::text AS d")).rows[0].d;
    for (let i = 1; i <= backfill; i++) {
      const d = addDays(todayPg, -i);
      if (!got.has(d)) backfillDays.push(d);
    }
  }
  return { openDays: open.rows.map((x) => x.d), routesStored, backfillDays };
}

async function writeDay(client, day, rows, finalize) {
  await client.query("DELETE FROM opd_hourly WHERE visit_date = $1", [day]);
  const hc = [], hh = [], ha = [], hs = [], hws = [], hwn = [];
  for (const r of rows) {
    r.hourly.forEach((x, hour) => {
      if (!x.arrived && !x.seen) return;
      hc.push(r.clinic); hh.push(hour); ha.push(x.arrived); hs.push(x.seen); hws.push(x.waitSum); hwn.push(x.waitN);
    });
  }
  await client.query(
    `INSERT INTO opd_hourly (visit_date, clinic_code, hour, arrived, seen, wait_sum, wait_n)
     SELECT $1::date, x.c, x.h, x.a, x.s, x.ws, x.wn
       FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[]) AS x(c, h, a, s, ws, wn)`,
    [day, hc, hh, ha, hs, hws, hwn],
  );
  const d = rows.filter((r) => r.visits > 0);
  await client.query(
    `INSERT INTO opd_daily (visit_date, clinic_code, clinic_name, visits, seen, avg_wait, median_wait, p90_wait,
                            within60_pct, wait_minutes, finalized_at, updated_at)
     SELECT $1::date, x.c, x.name, x.v, x.s, x.avg, x.med, x.p90, x.w60,
            CASE WHEN x.waits = '' THEN '{}'::int[] ELSE string_to_array(x.waits, ',')::int[] END,
            CASE WHEN $2::boolean THEN now() END, now()
       FROM unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::numeric[], $8::numeric[], $9::numeric[],
                   $10::numeric[], $11::text[]) AS x(c, name, v, s, avg, med, p90, w60, waits)
     ON CONFLICT (visit_date, clinic_code) DO UPDATE
       SET clinic_name = EXCLUDED.clinic_name, visits = EXCLUDED.visits, seen = EXCLUDED.seen,
           avg_wait = EXCLUDED.avg_wait, median_wait = EXCLUDED.median_wait, p90_wait = EXCLUDED.p90_wait,
           within60_pct = EXCLUDED.within60_pct, wait_minutes = EXCLUDED.wait_minutes,
           finalized_at = EXCLUDED.finalized_at, updated_at = now()
       WHERE opd_daily.finalized_at IS NULL`,
    [
      day,
      finalize,
      d.map((r) => r.clinic),
      d.map((r) => r.name),
      d.map((r) => r.visits),
      d.map((r) => r.seen),
      d.map((r) => r.avg),
      d.map((r) => r.median),
      d.map((r) => r.p90),
      d.map((r) => r.within60),
      d.map((r) => r.waits.join(",")),
    ],
  );
  if (finalize) {
    // clinics with a row from an earlier run but no visit in the recount
    await client.query(
      `UPDATE opd_daily SET visits = 0, seen = 0, avg_wait = NULL, median_wait = NULL, p90_wait = NULL,
              within60_pct = NULL, wait_minutes = '{}', finalized_at = now(), updated_at = now()
        WHERE visit_date = $1 AND finalized_at IS NULL`,
      [day],
    );
  } else {
    await client.query(
      "DELETE FROM opd_daily WHERE visit_date = $1 AND finalized_at IS NULL AND NOT (clinic_code = ANY($2::text[]))",
      [day, d.map((r) => r.clinic)],
    );
  }
}

async function writePg(client, h, s, startedAt) {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);

  const codes = [...s.clinicSet].sort();
  await client.query(
    `INSERT INTO his_opd_clinic (clinic_code, his_name, active, visits_28d, synced_at)
     SELECT x.c, x.name, true, x.n, now() FROM unnest($1::text[], $2::text[], $3::int[]) AS x(c, name, n)
     ON CONFLICT (clinic_code) DO UPDATE
       SET his_name = EXCLUDED.his_name, active = true, synced_at = now(),
           visits_28d = CASE WHEN $4::boolean THEN EXCLUDED.visits_28d ELSE his_opd_clinic.visits_28d END`,
    [codes, codes.map((c) => h.names.get(c) ?? `แผนก ${c}`), codes.map((c) => h.routes.clinics.get(c) ?? 0), h.routesFresh],
  );
  if (h.routesFresh) {
    await client.query("UPDATE his_opd_clinic SET active = false, synced_at = now() WHERE active AND NOT (clinic_code = ANY($1::text[]))", [codes]);
    await client.query("DELETE FROM opd_route");
    const r = h.routes.routes.filter((x) => s.clinicSet.has(x.clinicCode));
    await client.query(
      `INSERT INTO opd_route (from_dep, clinic_code, visits, seen_share, computed_at)
       SELECT x.d, x.c, x.v, x.s, now() FROM unnest($1::text[], $2::text[], $3::int[], $4::numeric[]) AS x(d, c, v, s)`,
      [r.map((x) => x.fromDep), r.map((x) => x.clinicCode), r.map((x) => x.visits), r.map((x) => x.share)],
    );
  }

  const [run] = (
    await client.query(
      `INSERT INTO sync_run (started_at, finished_at, ok, his_today, job) VALUES ($1, clock_timestamp(), true, $2, 'opd') RETURNING id`,
      [startedAt, h.today],
    )
  ).rows;

  await client.query("DELETE FROM opd_state");
  const t = s.today;
  await client.query(
    `INSERT INTO opd_state (clinic_code, sync_run_id, visit_date, waiting_now, waiting_for_doctor, longest_wait_minutes,
                            seen_today, visits_today, seen_last_hour, doctors_active, wait_minutes)
     SELECT x.c, $1::bigint, $2::date, x.wn, x.wfd, x.lw, x.st, x.vt, x.slh, x.da,
            CASE WHEN x.waits = '' THEN '{}'::int[] ELSE string_to_array(x.waits, ',')::int[] END
       FROM unnest($3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::int[], $11::text[])
            AS x(c, wn, wfd, lw, st, vt, slh, da, waits)`,
    [
      run.id,
      h.today,
      t.map((r) => r.clinic),
      t.map((r) => r.e.waitingNow),
      t.map((r) => r.e.waitingForDoctor),
      t.map((r) => r.e.longestWait),
      t.map((r) => r.seen),
      t.map((r) => r.visits),
      t.map((r) => r.e.seenLastHour),
      t.map((r) => r.doctorsActive),
      t.map((r) => r.waits.join(",")),
    ],
  );

  for (const c of s.closing) await writeDay(client, c.day, c.rows, true);
  await writeDay(client, h.today, s.today, false);

  await client.query("COMMIT");
  return run.id;
}

async function logFailure(client, startedAt, code) {
  try {
    await client.query(
      `INSERT INTO sync_run (started_at, finished_at, ok, error_code, job) VALUES ($1, clock_timestamp(), false, $2, 'opd')`,
      [startedAt, code.slice(0, 60)],
    );
  } catch {
    // PostgreSQL itself is the problem; the cron log has the code.
  }
}

async function main() {
  const startedAt = new Date();
  let client = null;
  let his = null;
  let stage = "his";
  try {
    let pgState = { openDays: [], routesStored: null, backfillDays: [] };
    if (!dryRun) {
      stage = "pg";
      client = await openPg("bkh-wait-sync-opd");
      pgState = await readPgState(client);
    }
    stage = "his";
    his = await openHis();
    const h = await readHis(his, pgState);
    await his.close();
    his = null;
    const s = summarize(h);

    if (dryRun) {
      console.log(JSON.stringify(dryRunReport(h, s), null, 2));
      return;
    }
    stage = "pg";
    const runId = await writePg(client, h, s, startedAt);
    const waiting = s.today.reduce((n, r) => n + r.e.waitingNow, 0);
    const seen = s.today.reduce((n, r) => n + r.seen, 0);
    console.log(
      `${ts()} opd sync ok: run ${runId}, ${h.today}, ${s.clinicSet.size} clinic(s), waiting ${waiting}, seen ${seen}` +
        (h.routesFresh ? ", routes refreshed" : "") +
        (h.closing.length ? `, finalized ${h.closing.map((c) => c.day).join(" ")}` : "") +
        `, ${Date.now() - startedAt.getTime()} ms`,
    );
  } catch (err) {
    const code = stage === "his" && !(err instanceof SyncError) ? `HIS_${errCode(err)}` : pgCode(err);
    console.error(`${ts()} opd sync FAILED: ${code}${err instanceof SyncError && err.message !== code ? ` (${err.message})` : ""}`);
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      await logFailure(client, startedAt, code);
    }
    process.exitCode = 1;
  } finally {
    if (his) await his.close();
    if (client) await client.end().catch(() => {});
  }
}

await main();
