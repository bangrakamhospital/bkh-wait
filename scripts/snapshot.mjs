#!/usr/bin/env node
// Take one occupancy snapshot (one wait.occupancy_snapshot row per ward)
// by calling the running app: POST /api/snapshot with the bearer token.
// The SQL lives only in the app (src/lib/beds), this script is a trigger.
//
//   npm run snapshot          (loads .env)
//
// Env: WAIT_SNAPSHOT_TOKEN (required, same value the app reads)
//      WAIT_INTERNAL_URL   (default http://127.0.0.1:3084)
//
// Cron (every 15 minutes, as the pm2 user):
//   */15 * * * * cd /var/www/wait && /usr/bin/node --env-file=.env scripts/snapshot.mjs >> /var/www/wait/logs/snapshot.log 2>&1
// Never prints the token.

const token = process.env.WAIT_SNAPSHOT_TOKEN?.trim();
const base = (process.env.WAIT_INTERNAL_URL?.trim() || "http://127.0.0.1:3084").replace(/\/+$/, "");

if (!token) {
  console.error("snapshot: WAIT_SNAPSHOT_TOKEN is not set");
  process.exit(2);
}

try {
  const res = await fetch(`${base}/api/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${new Date().toISOString()} snapshot failed: HTTP ${res.status} ${body.code ?? ""}`);
    process.exit(1);
  }
  console.log(`${new Date().toISOString()} snapshot ok: ${body.wards} ward(s) at ${body.takenAt}`);
} catch (err) {
  console.error(`${new Date().toISOString()} snapshot failed: ${err instanceof Error ? err.name : String(err)}`);
  process.exit(1);
}
