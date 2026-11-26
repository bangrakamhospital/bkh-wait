import { recordLoginFailure, recordLoginSuccess, loginRetryAfter } from "@/lib/auth/rate-limit";
import { createSessionToken, isAuthConfigured, setSessionCookie } from "@/lib/auth/session";
import { verifyCredentials } from "@/lib/auth/users";
import { ApiError, clientIp, errorResponse, json, readJsonBody } from "@/lib/http";

const BAD_LOGIN = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง";

export async function POST(request: Request) {
  try {
    if (!isAuthConfigured()) {
      throw new ApiError(503, "AUTH_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่าการเข้าสู่ระบบ (WAIT_SESSION_SECRET)");
    }
    const body = await readJsonBody(request);
    const username = typeof body.username === "string" ? body.username.trim().slice(0, 64) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const ip = clientIp(request.headers);

    const retry = loginRetryAfter(ip, username);
    if (retry > 0) {
      throw new ApiError(429, "TOO_MANY_ATTEMPTS", "พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่", {
        "Retry-After": String(retry),
      });
    }
    const user = username && password ? await verifyCredentials(username, password) : null;
    if (!user) {
      recordLoginFailure(ip, username);
      throw new ApiError(401, "UNAUTHENTICATED", BAD_LOGIN);
    }
    recordLoginSuccess(ip, username);
    await setSessionCookie(createSessionToken(user));
    return json({ user: { username: user.username, role: user.role } });
  } catch (err) {
    return errorResponse(err, "api/login");
  }
}
