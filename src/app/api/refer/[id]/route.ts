import { invalidateBoardCache, updateReferStatus } from "@/lib/beds/board";
import { errorResponse, json, readJsonBody, requireSession, validation } from "@/lib/http";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(["staff", "partner"]);
    const { id } = await ctx.params;
    if (!/^\d{1,15}$/.test(id)) throw validation("id ไม่ถูกต้อง");
    const body = await readJsonBody(request);
    const updated = await updateReferStatus(
      Number(id),
      { status: body.status, ...("wardCode" in body ? { wardCode: body.wardCode } : {}) },
      session,
    );
    invalidateBoardCache();
    return json({ request: updated });
  } catch (err) {
    return errorResponse(err, "api/refer/[id]");
  }
}
