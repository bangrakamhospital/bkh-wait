import "server-only";

import { createHmac, randomBytes, randomInt } from "node:crypto";

import { authSecret } from "../auth/settings";

/**
 * Access-code generation + hashing (same scheme as bkh-kpi).
 *
 *  - Code: 16 symbols of Crockford base32 (no I, L, O, U) = 80 bits from
 *    the CSPRNG, shown as 4 groups: "7K3M-QX9P-2HDT-WV8R".
 *  - Input is normalised before hashing: upper-case, spaces / dashes
 *    removed, I/L -> 1, O -> 0 (common typing mistakes).
 *  - Stored value: HMAC-SHA256(key, normalised code), hex. The key is
 *    derived from WAIT_ACCESS_CODE_SECRET (>= 32 chars), else from the
 *    session secret (AUTH_SECRET / WAIT_SESSION_SECRET), so a database dump
 *    alone cannot be brute forced offline. No secret -> codes cannot be
 *    issued or used (fail closed). Rotating the secret in use invalidates
 *    every issued code.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;
const MIN_SECRET = 32;
const KEY_LABEL = "bkh-wait/access-code/v1";

export function generateAccessCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join("-");
}

export function generateAccessCodeId(): string {
  return `ac-${randomBytes(9).toString("base64url")}`;
}

/** Canonical 16-symbol form, or null when the input cannot be a code. */
export function normalizeAccessCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

let warnedShortSecret = false;

function hashKey(): Buffer | null {
  const own = process.env.WAIT_ACCESS_CODE_SECRET ?? "";
  if (own.length > 0 && own.length < MIN_SECRET && !warnedShortSecret) {
    warnedShortSecret = true;
    console.warn("[auth] WAIT_ACCESS_CODE_SECRET ignored: shorter than 32 characters; using AUTH_SECRET");
  }
  const secret = own.length >= MIN_SECRET ? own : authSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

export function accessCodeHashingReady(): boolean {
  return hashKey() !== null;
}

/** HMAC (hex) of a NORMALISED code; throws when no secret is configured. */
export function hashAccessCode(normalized: string): string {
  const key = hashKey();
  if (!key) throw new Error("access code secret not configured");
  return createHmac("sha256", key).update(normalized).digest("hex");
}
