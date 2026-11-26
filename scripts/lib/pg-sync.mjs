// PostgreSQL connection of the sync workers (scripts/sync-hosxp.mjs,
// scripts/sync-opd.mjs): role bkh_wait_sync via WAIT_SYNC_DATABASE_URL
// (.env.sync). Errors carry a short code only, never the URL or password.

import pg from "pg";

import { errCode, SyncError } from "./hosxp.mjs";

const PG_OPTIONS =
  "-c search_path=wait -c TimeZone=Asia/Bangkok -c statement_timeout=30000 " +
  "-c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000";

export function pgCode(err) {
  if (err instanceof SyncError) return err.code;
  return `PG_${errCode(err)}`;
}

export async function openPg(applicationName = "bkh-wait-sync") {
  const url = process.env.WAIT_SYNC_DATABASE_URL?.trim();
  if (!url) throw new SyncError("PG_NOT_CONFIGURED", "WAIT_SYNC_DATABASE_URL is not set");
  const client = new pg.Client({
    connectionString: url,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    options: PG_OPTIONS,
  });
  // pg types: keep DATE as text
  client.setTypeParser(pg.types.builtins.DATE, (v) => v);
  try {
    await client.connect();
  } catch (err) {
    throw new SyncError(`PG_${errCode(err)}`, "PostgreSQL connection failed");
  }
  client.on("error", () => {});
  return client;
}
