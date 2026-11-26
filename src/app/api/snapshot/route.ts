import { createHash, timingSafeEqual } from "node:crypto";

import { takeOccupancySnapshot } from "@/lib/beds/board";
import { ApiError, errorResponse, json } from "@/lib/http";

/**
 * Internal: cron (scripts/snapshot.mjs, every 15 min) writes one
 * occupancy_snapshot row per ward. Bearer token = WAIT_SNAPSHOT_TOKEN
 * (>= 32 chars); unset -> endpoint disabled (403).
 */
function authorized(header: string | null): boolean {
  const token = process.env.WAIT_SNAPSHOT_TOKEN ?? "";
  if (token.length < 32 || !header?.startsWith("Bearer ")) return false;
  // Compare fixed-length digests so length differences do not leak.
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    if (!authorized(request.headers.get("authorization"))) {
      throw new ApiError(403, "FORBIDDEN", "forbidden");
    }
    return json(await takeOccupancySnapshot());
  } catch (err) {
    return errorResponse(err, "api/snapshot");
  }
}
