import "server-only";

import {
  createPool,
  type Pool as CorePool,
  type PoolConnection as CorePoolConnection,
  type RowDataPacket,
} from "mysql2";
import type { Pool } from "mysql2/promise";

/**
 * Read-only connection pool to HOSxP of Bangrakam hospital (hospcode 11252,
 * MySQL/MariaDB).
 *
 * - Credentials come from server-only env vars HIS_HOST, HIS_PORT, HIS_USER,
 *   HIS_PASSWORD, HIS_DATABASE; values are never logged or included in
 *   error messages (only variable NAMES and mysql2 error codes).
 * - Every new connection runs `SET SESSION TRANSACTION READ ONLY`; if that
 *   fails the connection is destroyed (fail closed). The DB account should
 *   still be granted SELECT only — this is a second line of defence.
 * - Use `hisQuery()` with named placeholders (`:name`) only. It runs
 *   server-side prepared statements (`execute`). Never build SQL from input.
 */

const ENV_KEYS = [
  "HIS_HOST",
  "HIS_PORT",
  "HIS_USER",
  "HIS_PASSWORD",
  "HIS_DATABASE",
] as const;

const QUERY_TIMEOUT_MS = 30_000;

export class HisConfigError extends Error {
  override name = "HisConfigError";
}

export class HisQueryError extends Error {
  override name = "HisQueryError";
  /** mysql2 error code only (e.g. "ECONNREFUSED"), never the raw message. */
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(code ? `${message} (${code})` : message);
    this.code = code;
  }
}

export type HisParams = Record<string, string | number | null>;

function readConfig() {
  const env = process.env;
  // Report missing variable *names* only, never values.
  const missing = ENV_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new HisConfigError(
      `Missing HIS database environment variables: ${missing.join(", ")}`,
    );
  }
  const port = Number(env.HIS_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new HisConfigError("HIS_PORT is not a valid port number");
  }
  return {
    host: env.HIS_HOST as string,
    port,
    user: env.HIS_USER as string,
    password: env.HIS_PASSWORD as string,
    database: env.HIS_DATABASE as string,
  };
}

function createReadOnlyPool(): Pool {
  const core: CorePool = createPool({
    ...readConfig(),
    connectionLimit: 4,
    maxIdle: 2,
    idleTimeout: 60_000,
    waitForConnections: true,
    queueLimit: 50,
    connectTimeout: 10_000,
    charset: "utf8mb4_unicode_ci",
    // HOSxP stores local (Thai) date/time without zone.
    timezone: "+07:00",
    // Return DATE/DATETIME as strings — no implicit JS Date conversion.
    dateStrings: true,
    namedPlaceholders: true,
    multipleStatements: false,
    decimalNumbers: true,
  });

  core.on("connection", (conn: CorePoolConnection) => {
    // Queued before any query on this connection, so it always runs first.
    conn.query("SET SESSION TRANSACTION READ ONLY", (err) => {
      if (err) conn.destroy();
    });
  });

  return core.promise();
}

// globalThis so the pool survives dev HMR.
const store = globalThis as unknown as { __waitHisPool?: Pool };

function getPool(): Pool {
  if (!store.__waitHisPool) store.__waitHisPool = createReadOnlyPool();
  return store.__waitHisPool;
}

/** Run a parameterized SELECT against HOSxP and return rows. */
export async function hisQuery<T extends RowDataPacket>(
  sql: string,
  params: HisParams = {},
): Promise<T[]> {
  const pool = getPool();
  try {
    const [rows] = await pool.execute<T[]>(
      { sql, timeout: QUERY_TIMEOUT_MS },
      params,
    );
    return rows;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : undefined;
    throw new HisQueryError("HIS query failed", code);
  }
}
