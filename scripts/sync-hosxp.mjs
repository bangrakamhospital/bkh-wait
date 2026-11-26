#!/usr/bin/env node
// HOSxP -> PostgreSQL sync worker. The ONLY component of bkh-wait that
// holds HOSxP credentials; the web app reads what this writes.
//
//   node --env-file=/var/www/wait/.env.sync scripts/sync-hosxp.mjs
//   node --env-file=.env.sync scripts/sync-hosxp.mjs --dry-run
//
// Env (own file, mode 0600, see .env.sync.example — NOT the web app's .env):
//   HIS_HOST HIS_PORT HIS_USER HIS_PASSWORD HIS_DATABASE   HOSxP, SELECT-only account
//   WAIT_SYNC_DATABASE_URL  postgres://bkh_wait_sync:<pw>@127.0.0.1:5432/bkh_wait
//
// Cron (every 15 min): see README "Sync worker".
//
// One run:
//   1. reads HOSxP (scripts/lib/hosxp.mjs: ward list, spclty names, current
//      census per ward and per ward x spclty, today's admitted / discharged /
//      midnight census, dominant spclty every 6 h, the whole-day figures
//      of every earlier day whose daily_census rows are still open, the
//      physical beds and — RESTRICTED — the HN on each occupied bed)
//   2. writes PostgreSQL in ONE transaction (advisory lock, so two runs never
//      interleave): his_spclty, his_ward, ward_state, ward_spclty_state,
//      occupancy_snapshot (one row per non-virtual ward, minute precision,
//      repeats in the same minute ignored), daily_census (today upserted,
//      earlier open days finalized), bed_slot (public: beds + occupied
//      flag) and bed_occupant (restricted: HN per bed, db/006), both
//      replaced as a whole and for non-virtual wards only, sync_run (ok)
//   3. on failure: rollback, then a sync_run row with ok = false and a short
//      error code (no message, host or credential), exit code 1
// Re-running is safe: every write is an upsert / replace.
//
// --dry-run: step 1 only, no PostgreSQL. Prints the aggregates it would
// write (ward_config overrides are not applied: HOSxP capacities, ward 17
// virtual by default). Bed occupants appear as COUNTS only — no HN is ever
// printed or logged by this worker.

import {
  errCode,
  fetchActiveWards,
  fetchBedOccupants,
  fetchBedSlots,
  fetchClock,
  fetchDayStats,
  fetchDominantSpclty,
  fetchSpclty,
  fetchSpcltyCensus,
  fetchWardCensus,
  openHis,
  SyncError,
} from "./lib/hosxp.mjs";
import { openPg, pgCode } from "./lib/pg-sync.mjs";

const LOCK_KEY = 72_517_085; // pg_advisory_xact_lock (migrate uses ...084)
const DOMINANT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_VIRTUAL_WARDS = new Set(["17"]); // = ward_catalog view / config.ts

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log("usage: node --env-file=.env.sync scripts/sync-hosxp.mjs [--dry-run]");
  process.exit(0);
}
const dryRun = args.has("--dry-run");

const ts = () => new Date().toISOString();

/** Everything read from HOSxP in one run. */
async function readHis(his, { needDominant, openDays }) {
  const clock = await fetchClock(his);
  const [wards, spclty, census, spcltyCensus, today] = [
    await fetchActiveWards(his),
    await fetchSpclty(his),
    await fetchWardCensus(his),
    await fetchSpcltyCensus(his),
    await fetchDayStats(his, clock.today),
  ];
  const bedSlots = await fetchBedSlots(his);
  const bedOccupants = await fetchBedOccupants(his);
  const dominant = needDominant ? await fetchDominantSpclty(his) : null;
  const closing = [];
  for (const day of openDays) {
    if (day < clock.today) closing.push({ day, stats: await fetchDayStats(his, day) });
  }
  return { clock, wards, spclty, census, spcltyCensus, today, dominant, closing, bedSlots, bedOccupants };
}

/**
 * Bed slots with their occupied flag + the occupants that sit on a known
 * slot of the same ward (one row per bed and HN).
 */
function bedLayout(h) {
  const slotWard = new Map(h.bedSlots.map((b) => [b.bedno, b.wardCode]));
  const seen = new Set();
  const occupants = [];
  for (const o of h.bedOccupants) {
    if (slotWard.get(o.bedno) !== o.wardCode) continue;
    const key = `${o.bedno}|${o.hn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occupants.push(o);
  }
  const occupiedBeds = new Set(occupants.map((o) => o.bedno));
  const slots = h.bedSlots.map((b, i) => ({ ...b, sortOrder: i, occupied: occupiedBeds.has(b.bedno) }));
  return { slots, occupants };
}

const zeroCensus = { occupied: 0, bedsInUse: 0, admittedToday: 0, dischargedToday: 0 };
const zeroDay = { admitted: 0, discharged: 0, patientDays: 0 };

function dryRunReport(h) {
  const layout = bedLayout(h);
  const rows = h.wards.map((w) => {
    const slots = layout.slots.filter((b) => b.wardCode === w.wardCode);
    const c = h.census.get(w.wardCode) ?? zeroCensus;
    const d = h.today.get(w.wardCode) ?? zeroDay;
    return {
      wardCode: w.wardCode,
      virtual: DEFAULT_VIRTUAL_WARDS.has(w.wardCode),
      beds: w.beds,
      occupied: c.occupied,
      bedsInUse: c.bedsInUse,
      available: Math.max(w.beds - c.bedsInUse, 0),
      admittedToday: d.admitted,
      dischargedToday: d.discharged,
      patientDaysSoFar: d.patientDays,
      // bed_slot rows / occupied slots / bed_occupant rows (counts only, never HN)
      bedSlots: slots.length,
      bedSlotsOccupied: slots.filter((b) => b.occupied).length,
      bedOccupants: layout.occupants.filter((o) => o.wardCode === w.wardCode).length,
    };
  });
  const shown = rows.filter((r) => !r.virtual);
  const sum = (k) => shown.reduce((n, r) => n + r[k], 0);
  const beds = sum("beds");
  const available = sum("available");
  return {
    dryRun: true,
    hisClock: h.clock,
    wards: rows,
    totals: {
      wards: shown.length,
      beds,
      occupied: sum("occupied"),
      bedsInUse: sum("bedsInUse"),
      available,
      occupancyPct: beds > 0 ? Math.round(((beds - available) / beds) * 1000) / 10 : 0,
      admittedToday: sum("admittedToday"),
      dischargedToday: sum("dischargedToday"),
      bedSlots: sum("bedSlots"),
      bedSlotsOccupied: sum("bedSlotsOccupied"),
      bedOccupants: sum("bedOccupants"),
    },
    spcltyNames: h.spclty.length,
    spcltyCells: h.spcltyCensus.length,
    dominantSpclty: h.dominant ? Object.fromEntries(h.dominant) : null,
    wouldFinalize: h.closing.map((c) => ({
      day: c.day,
      wards: Object.fromEntries([...c.stats].filter(([k]) => !DEFAULT_VIRTUAL_WARDS.has(k))),
    })),
  };
}

async function writePg(client, h, startedAt) {
  const active = h.wards.map((w) => w.wardCode);
  const activeSet = new Set(active);
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);

  await client.query(
    `INSERT INTO his_spclty (spclty_code, name, synced_at)
     SELECT x.code, x.name, now() FROM unnest($1::text[], $2::text[]) AS x(code, name)
     ON CONFLICT (spclty_code) DO UPDATE SET name = EXCLUDED.name, synced_at = now()`,
    [h.spclty.map((s) => s.code), h.spclty.map((s) => s.name)],
  );

  const dom = h.dominant;
  await client.query(
    `INSERT INTO his_ward (ward_code, his_name, his_beds, active, dominant_spclty_code, dominant_at, synced_at)
     SELECT x.code, x.name, x.beds, true, x.dom, CASE WHEN $5::boolean THEN now() END, now()
       FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS x(code, name, beds, dom)
     ON CONFLICT (ward_code) DO UPDATE
       SET his_name = EXCLUDED.his_name, his_beds = EXCLUDED.his_beds, active = true, synced_at = now(),
           dominant_spclty_code = CASE WHEN $5 THEN EXCLUDED.dominant_spclty_code ELSE his_ward.dominant_spclty_code END,
           dominant_at = CASE WHEN $5 THEN now() ELSE his_ward.dominant_at END`,
    [
      active,
      h.wards.map((w) => w.wardName),
      h.wards.map((w) => w.beds),
      h.wards.map((w) => (dom ? (dom.get(w.wardCode) ?? null) : null)),
      dom !== null,
    ],
  );
  await client.query(
    "UPDATE his_ward SET active = false, synced_at = now() WHERE active AND NOT (ward_code = ANY($1::text[]))",
    [active],
  );

  const [run] = (
    await client.query(
      `INSERT INTO sync_run (started_at, finished_at, ok, his_today, wards)
       VALUES ($1, clock_timestamp(), true, $2, $3) RETURNING id`,
      [startedAt, h.clock.today, active.length],
    )
  ).rows;

  // Current state: replaced as a whole.
  await client.query("DELETE FROM ward_spclty_state");
  await client.query("DELETE FROM ward_state");
  const c = active.map((code) => h.census.get(code) ?? zeroCensus);
  await client.query(
    `INSERT INTO ward_state (ward_code, sync_run_id, occupied, beds_in_use, admitted_today, discharged_today)
     SELECT x.code, $1::bigint, x.occ, x.inuse, x.adm, x.dis
       FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[]) AS x(code, occ, inuse, adm, dis)`,
    [
      run.id,
      active,
      c.map((x) => x.occupied),
      c.map((x) => x.bedsInUse),
      c.map((x) => x.admittedToday),
      c.map((x) => x.dischargedToday),
    ],
  );
  const sp = h.spcltyCensus.filter((s) => activeSet.has(s.wardCode) && s.occupied > 0);
  await client.query(
    `INSERT INTO ward_spclty_state (ward_code, spclty_code, occupied)
     SELECT x.code, x.sp, x.n FROM unnest($1::text[], $2::text[], $3::int[]) AS x(code, sp, n)`,
    [sp.map((s) => s.wardCode), sp.map((s) => s.spcltyCode), sp.map((s) => s.occupied)],
  );

  // Beds: replaced as a whole, non-virtual wards only (ward_catalog sees the
  // his_ward rows written above). bed_occupant (HN, restricted) first: it
  // references bed_slot. The sync role may INSERT / DELETE it but not read it.
  const layout = bedLayout(h);
  await client.query("DELETE FROM bed_occupant");
  await client.query("DELETE FROM bed_slot");
  const bs = layout.slots;
  await client.query(
    `INSERT INTO bed_slot (bedno, ward_code, bed_name, room_no, room_name, sort_order, occupied, sync_run_id)
     SELECT x.bedno, x.ward, x.bed_name, x.room_no, x.room_name, x.ord, x.occ, $1::bigint
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::boolean[])
            AS x(bedno, ward, bed_name, room_no, room_name, ord, occ)
       JOIN ward_catalog c ON c.ward_code = x.ward
      WHERE c.active AND NOT c.is_virtual`,
    [
      run.id,
      bs.map((b) => b.bedno),
      bs.map((b) => b.wardCode),
      bs.map((b) => b.bedName),
      bs.map((b) => b.roomNo),
      bs.map((b) => b.roomName),
      bs.map((b) => b.sortOrder),
      bs.map((b) => b.occupied),
    ],
  );
  const oc = layout.occupants;
  await client.query(
    `INSERT INTO bed_occupant (bedno, ward_code, hn, admit_date, spclty_code, sync_run_id)
     SELECT x.bedno, x.ward, x.hn, x.adm, x.sp, $1::bigint
       FROM unnest($2::text[], $3::text[], $4::text[], $5::date[], $6::text[]) AS x(bedno, ward, hn, adm, sp)
       JOIN bed_slot s ON s.bedno = x.bedno AND s.ward_code = x.ward`,
    [
      run.id,
      oc.map((o) => o.bedno),
      oc.map((o) => o.wardCode),
      oc.map((o) => o.hn),
      oc.map((o) => o.admitDate),
      oc.map((o) => o.spcltyCode),
    ],
  );

  // History: one snapshot row per non-virtual ward (hidden wards included).
  await client.query(
    `INSERT INTO occupancy_snapshot (taken_at, ward_code, occupied, beds, beds_in_use)
     SELECT date_trunc('minute', now()), c.ward_code, s.occupied, c.beds, s.beds_in_use
       FROM ward_catalog c JOIN ward_state s ON s.ward_code = c.ward_code
      WHERE c.active AND NOT c.is_virtual
     ON CONFLICT (taken_at, ward_code) DO NOTHING`,
  );

  // Close earlier days: whole-day figures recomputed from HOSxP.
  for (const { day, stats } of h.closing) {
    const codes = [...stats.keys()];
    const v = codes.map((k) => stats.get(k));
    await client.query(
      `UPDATE daily_census d
          SET admitted = x.adm, discharged = x.dis, patient_days = x.pd,
              finalized_at = now(), updated_at = now()
         FROM unnest($2::text[], $3::int[], $4::int[], $5::int[]) AS x(code, adm, dis, pd)
        WHERE d.census_date = $1 AND d.ward_code = x.code AND d.finalized_at IS NULL`,
      [day, codes, v.map((s) => s.admitted), v.map((s) => s.discharged), v.map((s) => s.patientDays)],
    );
    // wards without any HOSxP row that day
    await client.query(
      `UPDATE daily_census SET admitted = 0, discharged = 0, patient_days = 0,
              finalized_at = now(), updated_at = now()
        WHERE census_date = $1 AND finalized_at IS NULL`,
      [day],
    );
  }

  // Today: upsert (beds in use = this sync, peak = max over the day).
  const tCodes = [...h.today.keys()];
  const tv = tCodes.map((k) => h.today.get(k));
  await client.query(
    `INSERT INTO daily_census (census_date, ward_code, ward_name, department_code, department_name, beds,
                               beds_in_use, peak_beds_in_use, admitted, discharged, patient_days, updated_at)
     SELECT $1::date, c.ward_code, c.ward_name, c.department_code, c.department_name, c.beds,
            s.beds_in_use, s.beds_in_use, coalesce(x.adm, 0), coalesce(x.dis, 0), coalesce(x.pd, 0), now()
       FROM ward_catalog c
       JOIN ward_state s ON s.ward_code = c.ward_code
       LEFT JOIN unnest($2::text[], $3::int[], $4::int[], $5::int[]) AS x(code, adm, dis, pd) ON x.code = c.ward_code
      WHERE c.active AND NOT c.is_virtual
     ON CONFLICT (census_date, ward_code) DO UPDATE
       SET ward_name = EXCLUDED.ward_name, department_code = EXCLUDED.department_code,
           department_name = EXCLUDED.department_name, beds = EXCLUDED.beds,
           beds_in_use = EXCLUDED.beds_in_use,
           peak_beds_in_use = GREATEST(daily_census.peak_beds_in_use, EXCLUDED.beds_in_use),
           admitted = EXCLUDED.admitted, discharged = EXCLUDED.discharged,
           patient_days = EXCLUDED.patient_days, updated_at = now()
       WHERE daily_census.finalized_at IS NULL`,
    [h.clock.today, tCodes, tv.map((s) => s.admitted), tv.map((s) => s.discharged), tv.map((s) => s.patientDays)],
  );

  await client.query("COMMIT");
  return run.id;
}

async function logFailure(client, startedAt, code) {
  try {
    await client.query(
      `INSERT INTO sync_run (started_at, finished_at, ok, error_code) VALUES ($1, clock_timestamp(), false, $2)`,
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
    let openDays = [];
    let needDominant = true;
    if (!dryRun) {
      stage = "pg";
      client = await openPg();
      const open = await client.query(
        "SELECT DISTINCT census_date::text AS d FROM daily_census WHERE finalized_at IS NULL ORDER BY 1",
      );
      openDays = open.rows.map((r) => r.d);
      const dom = await client.query("SELECT max(dominant_at) AS at FROM his_ward WHERE active");
      const at = dom.rows[0]?.at;
      needDominant = !at || Date.now() - new Date(at).getTime() > DOMINANT_MAX_AGE_MS;
    }
    stage = "his";
    his = await openHis();
    const h = await readHis(his, { needDominant, openDays });
    await his.close();
    his = null;

    if (dryRun) {
      console.log(JSON.stringify(dryRunReport(h), null, 2));
      return;
    }
    stage = "pg";
    const runId = await writePg(client, h, startedAt);
    console.log(
      `${ts()} sync ok: run ${runId}, ${h.wards.length} ward(s), ${h.bedSlots.length} bed(s), today ${h.clock.today}` +
        (h.closing.length ? `, finalized ${h.closing.map((c) => c.day).join(" ")}` : "") +
        `, ${Date.now() - startedAt.getTime()} ms`,
    );
  } catch (err) {
    const code = stage === "his" && !(err instanceof SyncError) ? `HIS_${errCode(err)}` : pgCode(err);
    console.error(`${ts()} sync FAILED: ${code}${err instanceof SyncError && err.message !== code ? ` (${err.message})` : ""}`);
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
