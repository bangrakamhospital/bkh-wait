import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { pgQuery } from "@/lib/db/pg";
import { ApiError, clientIp, errorResponse, json } from "@/lib/http";

/**
 * Machine API for the central / regional level (/api/v1/*), see docs/api.md
 * "API สำหรับส่วนกลาง".
 *
 * - Auth: `Authorization: Bearer <key>`. Keys come from env WAIT_API_KEYS
 *   as comma separated `name:sha256hex` entries — only the SHA-256 of a key
 *   is stored (scripts/make-api-key.mjs makes a key + entry). The presented
 *   key is hashed and compared to EVERY entry with timingSafeEqual (no early
 *   exit, fixed length), so timing does not reveal which entry is close.
 * - Rate limit per key: RATE_MAX requests / RATE_WINDOW_MS (in memory, one
 *   pm2 instance). Failed authentication: FAIL_MAX / FAIL_WINDOW_MS per IP.
 * - Every authenticated call writes one audit_log row (key name, endpoint,
 *   query range, HTTP status) BEFORE data is returned.
 * - CORS off by default (no Access-Control-* headers). WAIT_API_CORS_ORIGINS
 *   (comma separated exact origins) enables it for those origins only.
 * - Aggregates only: hospcode, ward / department counts. No patient data.
 */

export const HOSPCODE = "11252";

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const FAIL_WINDOW_MS = 5 * 60_000;
const FAIL_MAX = 20;
const MAX_BUCKETS = 10_000;

interface KeyEntry {
  name: string;
  hash: Buffer;
}

let parsed: { raw: string; keys: KeyEntry[] } | null = null;

/** WAIT_API_KEYS -> entries (invalid entries are skipped with a log line naming the position only). */
function apiKeys(): KeyEntry[] {
  const raw = process.env.WAIT_API_KEYS ?? "";
  if (parsed?.raw === raw) return parsed.keys;
  const keys: KeyEntry[] = [];
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((entry, i) => {
      const [name, hash, ...rest] = entry.split(":");
      if (rest.length || !NAME_RE.test(name ?? "") || !HASH_RE.test((hash ?? "").toLowerCase())) {
        console.error(`[api/v1] WAIT_API_KEYS entry #${i + 1} is invalid (expected name:sha256hex) - ignored`);
        return;
      }
      keys.push({ name, hash: Buffer.from(hash.toLowerCase(), "hex") });
    });
  parsed = { raw, keys };
  return keys;
}

interface Bucket {
  count: number;
  resetAt: number;
}
const g = globalThis as unknown as { __waitApiBuckets?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__waitApiBuckets ??= new Map());

/** Counts one hit; returns seconds to wait when over `max`, else 0. */
function hit(key: string, max: number, windowMs: number, now = Date.now()): number {
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

function overLimit(key: string, max: number, now = Date.now()): number {
  const b = buckets.get(key);
  return b && b.resetAt > now && b.count >= max ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

/** The key name for a valid bearer key, else throws 401 / 429 / 503. */
function authenticate(request: Request): string {
  const keys = apiKeys();
  if (keys.length === 0) {
    throw new ApiError(503, "API_NOT_CONFIGURED", "ยังไม่ได้เปิดใช้ API (WAIT_API_KEYS)");
  }
  const ip = clientIp(request.headers);
  const failKey = `fail|${ip}`;
  const wait = overLimit(failKey, FAIL_MAX);
  if (wait) {
    throw new ApiError(429, "RATE_LIMITED", "เรียก API ผิดพลาดบ่อยเกินไป", { "Retry-After": String(wait) });
  }
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  let name: string | null = null;
  if (m) {
    const digest = createHash("sha256").update(m[1]).digest();
    for (const k of keys) {
      // every entry is compared (no early exit)
      if (timingSafeEqual(digest, k.hash) && name === null) name = k.name;
    }
  }
  if (!name) {
    hit(failKey, FAIL_MAX, FAIL_WINDOW_MS);
    throw new ApiError(401, "UNAUTHENTICATED", "API key ไม่ถูกต้อง", { "WWW-Authenticate": "Bearer" });
  }
  const retry = hit(`key|${name}`, RATE_MAX, RATE_WINDOW_MS);
  if (retry) {
    throw new ApiError(429, "RATE_LIMITED", `เกิน ${RATE_MAX} ครั้งต่อนาที`, { "Retry-After": String(retry) });
  }
  return name;
}

function corsHeaders(request: Request): Record<string, string> {
  const allowed = (process.env.WAIT_API_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

async function audit(keyName: string, endpoint: string, detail: Record<string, unknown>): Promise<void> {
  await pgQuery(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
     VALUES ($1, 'api.call', 'api', $2, $3::jsonb)`,
    [`api:${keyName}`, endpoint, JSON.stringify(detail)],
  );
}

export interface ApiContext {
  keyName: string;
  /** Query details to log in the audit row (e.g. the date range). */
  log: Record<string, unknown>;
}

/**
 * Wraps a /api/v1 GET handler: auth, rate limit, audit row, CORS, error
 * contract. `run` returns the JSON body; it may add fields to ctx.log.
 */
export async function handleApi(
  request: Request,
  endpoint: string,
  run: (ctx: ApiContext) => Promise<unknown>,
): Promise<Response> {
  const cors = corsHeaders(request);
  let ctx: ApiContext | null = null;
  try {
    ctx = { keyName: authenticate(request), log: {} };
    const body = await run(ctx);
    await audit(ctx.keyName, endpoint, { ...ctx.log, status: 200 });
    return json(body, 200, cors);
  } catch (err) {
    const res = errorResponse(err, `api/v1${endpoint}`);
    if (ctx) {
      // authenticated but failed (bad range, DB error): still audited, best effort
      await audit(ctx.keyName, endpoint, { ...ctx.log, status: res.status }).catch(() => {});
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}

/** CORS preflight: 204 with headers for an allowed origin, 403 otherwise. */
export function preflight(request: Request): Response {
  const cors = corsHeaders(request);
  if (!cors["Access-Control-Allow-Origin"]) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: cors });
}
