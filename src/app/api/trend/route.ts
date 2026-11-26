import type { NextRequest } from "next/server";

import { getOccupancyTrend } from "@/lib/beds/board";
import { isWaitDbConfigured } from "@/lib/db/pg";
import { errorResponse, intParam, json, validation } from "@/lib/http";

// Public: aggregate occupancy history.
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const hours = intParam(q.get("hours"), "hours", 24, 1, 168);
    const ward = q.get("ward") || null;
    if (ward !== null && !/^[0-9A-Za-z]{1,4}$/.test(ward)) throw validation("ward ไม่ถูกต้อง");
    const points = await getOccupancyTrend(hours, ward);
    return json({ hours, configured: isWaitDbConfigured(), points }, 200, {
      "Cache-Control": "public, max-age=60",
    });
  } catch (err) {
    return errorResponse(err, "api/trend");
  }
}
