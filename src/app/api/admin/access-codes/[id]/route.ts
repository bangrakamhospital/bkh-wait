import { adminActor, adminGate, assertSameOriginWrite } from "@/lib/admin/api";
import { revokeAccessCode, toAccessCodeView } from "@/lib/access-codes/store";
import { ApiError, errorResponse, json } from "@/lib/http";

// DELETE /api/admin/access-codes/{id} -> 200 { code } — revokes the code
// (row kept for the audit trail). Sessions using it end on their next request.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await adminGate();
    assertSameOriginWrite(request.headers);
    const { id } = await params;
    const result = await revokeAccessCode(id, adminActor(admin));
    if (!result.ok) throw new ApiError(404, "NOT_FOUND", "ไม่พบรหัสนี้");
    return json({ code: toAccessCodeView(result.record) });
  } catch (err) {
    return errorResponse(err, "api/admin/access-codes/[id]");
  }
}
