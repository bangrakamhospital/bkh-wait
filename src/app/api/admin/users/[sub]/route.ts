import { adminActor, adminGate, toAdminUser } from "@/lib/admin/api";
import { ApiError, errorResponse, json, readJsonBody, validation } from "@/lib/http";
import { isEnvAdmin } from "@/lib/users/policy";
import { MAX_SUB, updateUser } from "@/lib/users/store";
import { USER_ROLES, USER_STATUSES, type AdminUserPatch, type UserRole, type UserStatus } from "@/lib/users/types";

/**
 * PATCH /api/admin/users/{sub}   (sub = encodeURIComponent(OIDC sub))
 *   body { "status"?: "pending"|"approved"|"rejected", "role"?: "admin"|"staff" }
 * -> 200 { user }; 400 bad body; 401; 403 not admin / cross-origin; 404;
 *    409 own account / AUTH_ADMIN_SUBS account / last approved admin.
 * Takes effect on the user's next request (sessions re-read the store).
 */

function parsePatch(body: Record<string, unknown>): AdminUserPatch {
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => k !== "status" && k !== "role")) throw validation("ข้อมูลที่ส่งมาไม่ถูกต้อง");
  const patch: AdminUserPatch = {};
  if ("status" in body) {
    if (!(USER_STATUSES as readonly unknown[]).includes(body.status)) throw validation("status ไม่ถูกต้อง");
    patch.status = body.status as UserStatus;
  }
  if ("role" in body) {
    if (!(USER_ROLES as readonly unknown[]).includes(body.role)) throw validation("role ไม่ถูกต้อง");
    patch.role = body.role as UserRole;
  }
  return patch;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ sub: string }> }) {
  try {
    const admin = await adminGate();
    const patch = parsePatch(await readJsonBody(request));
    const { sub } = await params;
    if (!sub || sub.length > MAX_SUB || /[\u0000-\u001f\u007f]/.test(sub)) {
      throw new ApiError(404, "NOT_FOUND", "ไม่พบผู้ใช้");
    }
    const result = await updateUser(sub, patch, adminActor(admin), isEnvAdmin);
    if (!result.ok) {
      switch (result.error) {
        case "not_found":
          throw new ApiError(404, "NOT_FOUND", "ไม่พบผู้ใช้");
        case "self":
          throw new ApiError(409, "CONFLICT", "ไม่สามารถเปลี่ยนสถานะหรือสิทธิ์ของบัญชีตนเองได้");
        case "env_admin":
          throw new ApiError(409, "CONFLICT", "บัญชีนี้กำหนดเป็นผู้ดูแลระบบใน AUTH_ADMIN_SUBS แก้ไขได้ที่ค่าตั้งระบบเท่านั้น");
        case "last_admin":
          throw new ApiError(409, "CONFLICT", "ต้องมีผู้ดูแลระบบที่อนุมัติแล้วอย่างน้อย 1 คน");
      }
    }
    return json({ user: toAdminUser(result.user) });
  } catch (err) {
    return errorResponse(err, "api/admin/users/[sub]");
  }
}
