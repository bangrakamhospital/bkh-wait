/**
 * Access codes ("รหัสสำหรับบุคคลภายนอก"). Pure module (types + date
 * helpers), safe on client and server.
 *
 * An admin issues one code per outsider at /admin/access-codes. The
 * plaintext is shown ONCE at creation; only an HMAC of it is stored
 * (wait.access_code). A code session has role "partner": boards + own
 * refer-back requests, never HN. Revoked / expired codes end the session on
 * the next request.
 *
 *   GET    /api/admin/access-codes        -> 200 { codes: AccessCodeView[] }
 *   POST   /api/admin/access-codes        -> 201 { code, plaintext }
 *   DELETE /api/admin/access-codes/{id}   -> 200 { code } (revoked, row kept)
 */

export const ACCESS_CODE_DEFAULT_DAYS = 7;
export const ACCESS_CODE_MAX_DAYS = 90;
export const ACCESS_CODE_NAME_MAX = 100;
export const ACCESS_CODE_ORG_MAX = 120;
/** Characters of a code as typed (16 symbols + 3 dashes, spaces allowed). */
export const ACCESS_CODE_INPUT_MAX = 40;

export type AccessCodeStatus = "active" | "expired" | "revoked";

export interface AccessCodeActor {
  sub: string;
  name: string;
}

/** API / UI shape of a code (never the hash or the plaintext). */
export interface AccessCodeView {
  id: string;
  name: string;
  org: string;
  createdAt: string;
  createdBy: AccessCodeActor;
  expiresAt: string;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
  revokedBy: AccessCodeActor | null;
  status: AccessCodeStatus;
}

export interface AccessCodeCreateResponse {
  code: AccessCodeView;
  /** e.g. "7K3M-QX9P-2HDT-WV8R". Returned only here, once. */
  plaintext: string;
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Today's date (YYYY-MM-DD) in Asia/Bangkok (UTC+7, no DST). */
export function bangkokToday(now: Date = new Date()): string {
  return new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** `ymd` + `days` (calendar arithmetic). */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Last millisecond of a Bangkok calendar day, as ISO 8601 UTC. */
export function endOfBangkokDay(ymd: string): string {
  return new Date(Date.parse(`${ymd}T23:59:59.999Z`) - BANGKOK_OFFSET_MS).toISOString();
}

/**
 * Expiry of a code chosen for Bangkok day `ymd`: end of that day, but never
 * more than ACCESS_CODE_MAX_DAYS x 24 h from `now`.
 */
export function accessCodeExpiry(ymd: string, now: Date = new Date()): string {
  const cap = now.getTime() + ACCESS_CODE_MAX_DAYS * 24 * 60 * 60 * 1000;
  return new Date(Math.min(Date.parse(endOfBangkokDay(ymd)), cap)).toISOString();
}
