import { getBedBoard } from "@/lib/beds/board";
import { errorResponse, json } from "@/lib/http";

// Public: aggregate bed counts only (no patient data).
export async function GET() {
  try {
    const board = await getBedBoard();
    return json(board, 200, { "Cache-Control": "public, max-age=15, stale-while-revalidate=45" });
  } catch (err) {
    return errorResponse(err, "api/board");
  }
}
