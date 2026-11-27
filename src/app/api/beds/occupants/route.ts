import type { NextRequest } from "next/server";

import { hitRequestLimit } from "@/lib/auth/rate-limit";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { getWardOccupants, WARD_CODE_RE } from "@/lib/beds/occupants";
import { ApiError, assertSameOriginRead, errorResponse, json, requireSession, validation } from "@/lib/http";

// RESTRICTED: HN per bed of one ward. Staff / admin only (partner -> 403),
// same-origin only, rate limited per user, never cached, every successful
// read audit-logged by the database function (docs/api.md).
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(STAFF_ROLES);
    assertSameOriginRead(request.headers);
    const ward = request.nextUrl.searchParams.get("ward") ?? "";
    if (!WARD_CODE_RE.test(ward)) throw validation("ward ไม่ถูกต้อง");
    const retry = hitRequestLimit(`occupants|${session.username}`, RATE_MAX, RATE_WINDOW_MS);
    if (retry) {
      throw new ApiError(429, "RATE_LIMITED", `เกิน ${RATE_MAX} ครั้งต่อนาที`, { "Retry-After": String(retry) });
    }
    const body = await getWardOccupants(ward, session.actor);
    return json(body, 200, { Vary: "Cookie" });
  } catch (err) {
    return errorResponse(err, "api/beds/occupants");
  }
}
