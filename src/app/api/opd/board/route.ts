import { errorResponse, json } from "@/lib/http";
import { getOpdBoard } from "@/lib/opd/board";

// Public: OPD waiting-to-see-a-doctor aggregates per clinic (no patient data).
export async function GET() {
  try {
    const board = await getOpdBoard();
    return json(board, 200, { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" });
  } catch (err) {
    return errorResponse(err, "api/opd/board");
  }
}
