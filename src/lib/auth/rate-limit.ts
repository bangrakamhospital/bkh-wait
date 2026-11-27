import "server-only";

/**
 * In-memory brute-force limiter for login (per process; resets on restart;
 * enough for one pm2 instance on the intranet server).
 *   per IP + username : 5 failed attempts / 5 minutes
 *   per IP (any user) : 20 failed attempts / 5 minutes
 *   per username (any IP): 10 failed attempts / 5 minutes — stops a slow
 *     guess of one account spread over many IPs / spoofed X-Forwarded-For
 * Only failures count; a successful login clears the IP+username and
 * username keys.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 20;
const MAX_PER_USERNAME = 10;
const MAX_KEYS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const g = globalThis as unknown as { __waitLoginLimiter?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__waitLoginLimiter ??= new Map());

function prune(now: number) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  while (buckets.size > MAX_KEYS) {
    const first = buckets.keys().next().value;
    if (first === undefined) break;
    buckets.delete(first);
  }
}

function keys(ip: string, username: string) {
  const name = username.trim().toLowerCase();
  return { user: `u|${ip}|${name}`, ip: `i|${ip}`, name: `n|${name}` };
}

function active(key: string, now: number): Bucket | undefined {
  const b = buckets.get(key);
  if (b && b.resetAt <= now) {
    buckets.delete(key);
    return undefined;
  }
  return b;
}

/** Seconds until retry is allowed, or 0 when the attempt may proceed. */
export function loginRetryAfter(ip: string, username: string, now = Date.now()): number {
  const k = keys(ip, username);
  const u = active(k.user, now);
  const i = active(k.ip, now);
  const n = active(k.name, now);
  let until = 0;
  if (u && u.count >= MAX_PER_USER) until = Math.max(until, u.resetAt);
  if (i && i.count >= MAX_PER_IP) until = Math.max(until, i.resetAt);
  if (n && n.count >= MAX_PER_USERNAME) until = Math.max(until, n.resetAt);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

function bump(key: string, now: number) {
  const b = active(key, now);
  if (b) b.count += 1;
  else buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
}

export function recordLoginFailure(ip: string, username: string, now = Date.now()) {
  if (buckets.size > MAX_KEYS) prune(now);
  const k = keys(ip, username);
  bump(k.user, now);
  bump(k.ip, now);
  bump(k.name, now);
}

export function recordLoginSuccess(ip: string, username: string) {
  const k = keys(ip, username);
  buckets.delete(k.user);
  buckets.delete(k.name);
}

/**
 * Fixed-window request limiter for authenticated reads (per process, in
 * memory, separate from the login buckets). Counts one hit for `key`;
 * returns seconds to wait when over `max` per `windowMs`, else 0.
 */
const r = globalThis as unknown as { __waitRequestLimiter?: Map<string, Bucket> };
const requestBuckets: Map<string, Bucket> = (r.__waitRequestLimiter ??= new Map());

export function hitRequestLimit(key: string, max: number, windowMs: number, now = Date.now()): number {
  if (requestBuckets.size > MAX_KEYS) {
    for (const [k, b] of requestBuckets) if (b.resetAt <= now) requestBuckets.delete(k);
  }
  let b = requestBuckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    requestBuckets.set(key, b);
  }
  b.count += 1;
  return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

/**
 * Access-code login limiter (separate keys in the login buckets): 5 failed
 * codes / 5 minutes per IP (like bkh-kpi). Codes carry 80 bits from the
 * CSPRNG, so guessing is hopeless anyway; there is deliberately no global
 * limit (it would let one client lock every outsider out). A success clears
 * the IP key.
 */
const MAX_CODE_PER_IP = 5;

export function accessCodeRetryAfter(ip: string, now = Date.now()): number {
  const b = active(`c|${ip}`, now);
  return b && b.count >= MAX_CODE_PER_IP ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

export function recordAccessCodeFailure(ip: string, now = Date.now()) {
  if (buckets.size > MAX_KEYS) prune(now);
  bump(`c|${ip}`, now);
}

export function recordAccessCodeSuccess(ip: string) {
  buckets.delete(`c|${ip}`);
}
