import type { NextRequest } from "next/server";

import { createReferBack, invalidateBoardCache, listReferBack } from "@/lib/beds/board";
import { REFER_STATUSES } from "@/lib/beds/refer";
import type { ReferStatus } from "@/lib/beds/types";
import { ANY_ROLE } from "@/lib/auth/roles";
import { errorResponse, intParam, json, readJsonBody, requireSession, validation } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const q = request.nextUrl.searchParams;
    const statusParam = q.get("status");
    let statuses: ReferStatus[] | undefined;
    if (statusParam) {
      statuses = statusParam.split(",").map((s) => s.trim()) as ReferStatus[];
      if (statuses.some((s) => !REFER_STATUSES.includes(s))) throw validation("status ไม่ถูกต้อง");
    }
    const ward = q.get("ward") || null;
    if (ward !== null && !/^[0-9A-Za-z]{1,4}$/.test(ward)) throw validation("ward ไม่ถูกต้อง");
    // partner accounts see only the requests they created.
    const requests = await listReferBack(session.username, {
      statuses,
      wardCode: ward,
      days: intParam(q.get("days"), "days", 30, 1, 365),
      limit: intParam(q.get("limit"), "limit", 200, 1, 500),
      createdBy: session.role === "partner" ? session.username : null,
    });
    return json({ requests });
  } catch (err) {
    return errorResponse(err, "api/refer");
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(ANY_ROLE);
    const body = await readJsonBody(request);
    const created = await createReferBack(
      {
        caseRef: body.caseRef,
        fromHospital: body.fromHospital,
        wardCode: body.wardCode,
        diagnosisNote: body.diagnosisNote,
      },
      session,
    );
    invalidateBoardCache();
    return json({ request: created }, 201);
  } catch (err) {
    return errorResponse(err, "api/refer");
  }
}
