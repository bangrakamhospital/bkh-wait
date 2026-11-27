/**
 * Login error codes shared by the server (Auth.js `CredentialsSignin.code`
 * and the `/login?error=&code=` redirect of the SSO signIn callback) and
 * the login page. Pure module: safe on client and server. Codes never
 * reveal whether a username, password or access code exists.
 */

export const AUTH_DISABLED_MESSAGE = "ระบบเข้าสู่ระบบยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ";
export const GENERIC_LOGIN_ERROR = "ไม่สามารถเข้าสู่ระบบได้ กรุณาลองใหม่";

export const LOGIN_CODE = {
  /** Auth.js default for `CredentialsSignin` (authorize returned null). */
  invalid: "credentials",
  missing: "missing_input",
  disabled: "auth_disabled",
  unavailable: "provider_unavailable",
  /** Followed by `_<minutes>`, e.g. `rate_limited_5`. */
  rateLimited: "rate_limited",
  accessCodeInvalid: "access_code_invalid",
  accessCodeInactive: "access_code_inactive",
} as const;

/** `code` values of /login?error=AccessDenied set by the SSO signIn callback. */
export const SSO_CODE = {
  orgNotAllowed: "org_not_allowed",
  /** AUTH_PLKHEALTH_ALLOWED_ORGS is empty: SSO is fail-closed. */
  orgNotConfigured: "org_not_configured",
  pending: "pending",
  rejected: "rejected",
  userStoreUnavailable: "user_store_unavailable",
} as const;

export const ACCOUNT_PENDING_MESSAGE =
  "บัญชีของคุณอยู่ระหว่างรอผู้ดูแลระบบอนุมัติ เมื่ออนุมัติแล้วให้เข้าสู่ระบบอีกครั้ง";
export const USER_STORE_UNAVAILABLE_MESSAGE =
  "ไม่สามารถตรวจสอบสิทธิ์ผู้ใช้ได้ในขณะนี้ กรุณาลองใหม่ หากยังไม่ได้ให้ติดต่อผู้ดูแลระบบ";
export const ADMIN_ONLY_MESSAGE = "เฉพาะผู้ดูแลระบบเท่านั้น";

export function rateLimitedCode(retryAfterSeconds: number): string {
  return `${LOGIN_CODE.rateLimited}_${Math.max(1, Math.ceil(retryAfterSeconds / 60))}`;
}

/** Thai message for an Auth.js sign-in result (`error` + `code`). */
export function loginErrorMessage(error: string | null | undefined, code: string | null | undefined): string {
  switch (error) {
    case "AccessDenied":
      switch (code) {
        case SSO_CODE.orgNotAllowed:
          return "บัญชี Provider ID นี้ไม่ได้สังกัดหน่วยงานที่ได้รับอนุญาต";
        case SSO_CODE.orgNotConfigured:
          return "ยังไม่ได้กำหนดหน่วยงานที่อนุญาตให้เข้าสู่ระบบ กรุณาติดต่อผู้ดูแลระบบ";
        case SSO_CODE.pending:
          return ACCOUNT_PENDING_MESSAGE;
        case SSO_CODE.rejected:
          return "บัญชีของคุณไม่ได้รับอนุมัติให้ใช้งาน กรุณาติดต่อผู้ดูแลระบบ";
        case SSO_CODE.userStoreUnavailable:
          return USER_STORE_UNAVAILABLE_MESSAGE;
        default:
          return "ไม่ได้รับอนุญาตให้เข้าสู่ระบบ";
      }
    // Misconfiguration, or a stale / missing state / PKCE cookie (another
    // origin than the registered redirect URI, an old tab).
    case "Configuration":
      return "เข้าสู่ระบบไม่สำเร็จ (ระบบยังตั้งค่าไม่ครบหรือคำขอหมดอายุ) กรุณาลองใหม่ หากยังไม่ได้ให้ติดต่อผู้ดูแลระบบ";
    case "OAuthCallbackError":
      return "การเข้าสู่ระบบถูกยกเลิกหรือ Provider ID ปฏิเสธคำขอ กรุณาลองใหม่";
    case "OAuthSignInError":
      return "ไม่สามารถเชื่อมต่อ Provider ID ได้ในขณะนี้ กรุณาลองใหม่";
    case "CredentialsSignin":
      break;
    default:
      return error ? "เข้าสู่ระบบด้วย Provider ID ไม่สำเร็จ กรุณาลองใหม่" : GENERIC_LOGIN_ERROR;
  }
  const limited = code?.match(/^rate_limited_(\d{1,3})$/);
  if (limited) return `พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณาลองใหม่ในอีก ${limited[1]} นาที`;
  switch (code) {
    case LOGIN_CODE.missing:
      return "กรุณากรอกข้อมูลให้ครบ";
    case LOGIN_CODE.disabled:
      return AUTH_DISABLED_MESSAGE;
    case LOGIN_CODE.unavailable:
      return "ไม่สามารถตรวจสอบบัญชีได้ในขณะนี้ กรุณาลองใหม่";
    case LOGIN_CODE.accessCodeInvalid:
      return "รหัสไม่ถูกต้อง";
    case LOGIN_CODE.accessCodeInactive:
      return "รหัสนี้หมดอายุหรือถูกยกเลิกแล้ว กรุณาติดต่อผู้ดูแลระบบเพื่อขอรหัสใหม่";
    default:
      return "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง";
  }
}
