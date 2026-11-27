import type { NextRequest } from "next/server";

import { hitRequestLimit } from "@/lib/auth/rate-limit";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { ApiError, assertSameOriginRead, errorResponse, json, requireSession, validation } from "@/lib/http";
import { CLINIC_CODE_RE, getClinicWaiters } from "@/lib/opd/waiters";

// RESTRICTED: HN of the OPD visits waiting now in one clinic. Staff / admin
// only (partner -> 403, guest -> 401), same-origin only, rate limited per
// user, never cached, every successful read audit-logged by the database
// function (db/010, docs/api.md). Same rules as /api/beds/occupants.
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(STAFF_ROLES);
    assertSameOriginRead(request.headers);
    const clinic = request.nextUrl.searchParams.get("clinic") ?? "";
    if (!CLINIC_CODE_RE.test(clinic)) throw validation("clinic ไม่ถูกต้อง");
    const retry = hitRequestLimit(`opd-waiters|${session.username}`, RATE_MAX, RATE_WINDOW_MS);
    if (retry) {
      throw new ApiError(429, "RATE_LIMITED", `เกิน ${RATE_MAX} ครั้งต่อนาที`, { "Retry-After": String(retry) });
    }
    const body = await getClinicWaiters(clinic, session.actor);
    return json(body, 200, { Vary: "Cookie" });
  } catch (err) {
    return errorResponse(err, "api/opd/waiters");
  }
}
