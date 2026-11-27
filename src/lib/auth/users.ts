import "server-only";

import { createHash, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Backup / emergency accounts configured in env (Provider ID SSO and access
 * codes are the normal sign-in; these keep working when SSO is down or not
 * registered yet): a handful of refer / ward staff accounts in env, no user
 * table.
 *
 *   WAIT_USERS=alice:staff:scrypt.16384.8.1.<salt>.<key>,rc_phitsanulok:partner:scrypt...
 *
 * Entries are comma separated, fields colon separated:
 *   username  [a-z0-9_.-]{2,32} (case-insensitive, stored lower-case)
 *   role      "admin" | "staff" | "partner" (admin = staff + /admin pages)
 *   hash      scrypt.<N>.<r>.<p>.<salt base64url>.<key base64url>
 * Generate a hash with `node scripts/hash-password.mjs` (reads the
 * password from stdin). The format contains no "$", so Next's env
 * expansion cannot mangle it.
 */

import { ROLES, type Role } from "./roles";

export type { Role };

export interface StaffUser {
  username: string;
  role: Role;
  /** Short fingerprint of the password hash: changing the password revokes sessions. */
  fingerprint: string;
}

interface UserEntry extends StaffUser {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function parseEntry(raw: string): UserEntry | null {
  const [username, role, hash, ...rest] = raw.trim().split(":");
  if (rest.length > 0 || !username || !role || !hash) return null;
  const name = username.toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  if (!(ROLES as readonly string[]).includes(role)) return null;
  const parts = hash.split(".");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const [salt, key] = parts.slice(4);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  if (N < 16384 || N > 1 << 20 || (N & (N - 1)) !== 0 || r > 32 || p > 16) return null;
  if (!B64URL_RE.test(salt) || !B64URL_RE.test(key)) return null;
  const keyBuf = Buffer.from(key, "base64url");
  if (keyBuf.length < 32) return null;
  return {
    username: name,
    role: role as Role,
    fingerprint: createHash("sha256").update(hash).digest("base64url").slice(0, 12),
    N,
    r,
    p,
    salt: Buffer.from(salt, "base64url"),
    key: keyBuf,
  };
}

let cache: { raw: string; users: Map<string, UserEntry> } | null = null;

function loadUsers(): Map<string, UserEntry> {
  const raw = process.env.WAIT_USERS ?? "";
  if (cache && cache.raw === raw) return cache.users;
  const users = new Map<string, UserEntry>();
  let invalid = 0;
  for (const item of raw.split(",")) {
    if (!item.trim()) continue;
    const entry = parseEntry(item);
    if (entry && !users.has(entry.username)) users.set(entry.username, entry);
    else invalid += 1;
  }
  // Count only — never log the entries themselves.
  if (invalid > 0) console.warn(`[auth] ignored ${invalid} invalid WAIT_USERS entr(y/ies)`);
  cache = { raw, users };
  return users;
}

export function findUser(username: string): StaffUser | null {
  const u = loadUsers().get(username.trim().toLowerCase());
  return u ? { username: u.username, role: u.role, fingerprint: u.fingerprint } : null;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Used for unknown usernames so response time does not reveal which exist.
const DUMMY = {
  salt: Buffer.alloc(16, 7),
  key: Buffer.alloc(32),
  N: 16384,
  r: 8,
  p: 1,
};

/** Returns the user when username + password match, else null. */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<StaffUser | null> {
  if (password.length === 0 || password.length > 256) return null;
  const entry = loadUsers().get(username.trim().toLowerCase());
  const t = entry ?? DUMMY;
  const opts: ScryptOptions = { N: t.N, r: t.r, p: t.p, maxmem: 256 * t.N * t.r + 1024 * 1024 };
  const derived = await scryptAsync(password, t.salt, t.key.length, opts);
  const ok = timingSafeEqual(derived, t.key);
  if (!entry || !ok) return null;
  return { username: entry.username, role: entry.role, fingerprint: entry.fingerprint };
}

export function hasUsersConfigured(): boolean {
  return loadUsers().size > 0;
}
