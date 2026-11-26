import "server-only";

import pg from "pg";

/**
 * bkh-wait database (PostgreSQL `bkh_wait`, schema `wait`) — the ONLY
 * database this app talks to. The web app never connects to HOSxP: the
 * sync worker (scripts/sync-hosxp.mjs) copies aggregate counts into the
 * wait.his_ward / ward_state / daily_census tables, which this app reads.
 *
 * Env (server-only, never NEXT_PUBLIC_):
 *   WAIT_DATABASE_URL  postgres://bkh_wait_app:<password>@127.0.0.1:5432/bkh_wait
 * Not configured -> isWaitDbConfigured() false: every API that needs data
 * answers 503 WAIT_DB_NOT_CONFIGURED (the trend answers an empty list).
 *
 * Every connection: search_path wait, time zone Asia/Bangkok, statement
 * timeout 15 s, lock timeout 5 s, idle-in-transaction timeout 60 s.
 * Errors never carry connection details: only the SQLSTATE code.
 *
 * Type mapping: bigint / numeric -> number, date -> "YYYY-MM-DD" string,
 * timestamptz -> ISO 8601 string (UTC).
 */

export class WaitDbConfigError extends Error {
  override name = "WaitDbConfigError";
}

export class WaitDbError extends Error {
  override name = "WaitDbError";
  /** PostgreSQL SQLSTATE (e.g. "23505") or node error code; never the raw message. */
  readonly code: string | undefined;
  /** Constraint name of an integrity violation (schema identifier, safe to log). */
  readonly constraint: string | undefined;
  constructor(code: string | undefined, constraint: string | undefined) {
    super(code ? `wait db query failed (${code})` : "wait db query failed");
    this.code = code;
    this.constraint = constraint;
  }
}

function connectionString(): string | null {
  return process.env.WAIT_DATABASE_URL?.trim() || null;
}

export function isWaitDbConfigured(): boolean {
  return connectionString() !== null;
}

const tsParser = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ);
const PARSERS: Record<number, (value: string) => unknown> = {
  [pg.types.builtins.INT8]: (v) => Number(v),
  [pg.types.builtins.NUMERIC]: (v) => Number(v),
  [pg.types.builtins.DATE]: (v) => v,
  [pg.types.builtins.TIMESTAMPTZ]: (v) => {
    const d = tsParser(v) as Date;
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  },
};

const customTypes = {
  getTypeParser: ((oid: number, format?: string) =>
    PARSERS[oid] ??
    pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
};

// Startup parameters (sent in the connection handshake, so they apply
// before the first query and cannot be skipped).
const SESSION_OPTIONS =
  "-c search_path=wait -c TimeZone=Asia/Bangkok -c statement_timeout=15000 " +
  "-c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000";

const store = globalThis as unknown as { __waitPgPool?: pg.Pool };

function getPool(): pg.Pool {
  if (store.__waitPgPool) return store.__waitPgPool;
  const url = connectionString();
  if (!url) throw new WaitDbConfigError("wait database is not configured");
  const pool = new pg.Pool({
    connectionString: url,
    application_name: "bkh-wait",
    max: 8,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 5_000,
    types: customTypes,
    options: SESSION_OPTIONS,
  });
  // Idle client errors (server restart) must not crash the process.
  pool.on("error", (err) => {
    console.error(
      `[wait-db] idle client error (${(err as { code?: string }).code ?? err.name})`,
    );
  });
  store.__waitPgPool = pool;
  return pool;
}

function wrapError(err: unknown): never {
  if (err instanceof WaitDbConfigError) throw err;
  const e = err as { code?: unknown; constraint?: unknown } | null;
  const code = e && typeof e.code === "string" ? e.code : undefined;
  const constraint =
    e && typeof e.constraint === "string" ? e.constraint : undefined;
  throw new WaitDbError(code, constraint);
}

export type SqlParam =
  | string
  | number
  | boolean
  | null
  | readonly (string | number)[];

/** Anything that can run a query: the pool or a transaction client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly SqlParam[],
  ): Promise<R[]>;
}

function bind(
  run: (sql: string, params: unknown[]) => Promise<pg.QueryResult>,
): Queryable {
  return {
    async query<R extends pg.QueryResultRow>(
      sql: string,
      params: readonly SqlParam[] = [],
    ) {
      try {
        const res = await run(sql, params as unknown[]);
        return res.rows as R[];
      } catch (err) {
        wrapError(err);
      }
    },
  };
}

/** Parameterized query ($1, $2, ...) on the pool (autocommit). */
export async function pgQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<R[]> {
  return bind((s, p) => getPool().query(s, p)).query<R>(sql, params);
}

/**
 * Run `fn` in one transaction (BEGIN / COMMIT, ROLLBACK on any throw).
 * Default READ COMMITTED (use SELECT .. FOR UPDATE inside for row locks);
 * `{ snapshot: true }` = REPEATABLE READ READ ONLY, so several SELECTs see
 * the same committed sync run.
 */
export async function withPgTransaction<T>(
  fn: (tx: Queryable) => Promise<T>,
  opts: { snapshot?: boolean } = {},
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    wrapError(err);
  }
  const tx = bind((s, p) => client.query(s, p));
  let broken = false;
  try {
    await tx.query(opts.snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
