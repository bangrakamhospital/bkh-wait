import { invalidateBoardCache } from "@/lib/beds/board";
import { getDepartmentSettings, putDepartmentSettings } from "@/lib/beds/config";
import { errorResponse, json, readJsonBody, requireSession } from "@/lib/http";

// Public read: ward / department configuration only (no patient data).
export async function GET() {
  try {
    return json(await getDepartmentSettings());
  } catch (err) {
    return errorResponse(err, "api/departments");
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireSession(["staff"]);
    const body = await readJsonBody(request);
    const settings = await putDepartmentSettings(body, session.username);
    invalidateBoardCache();
    return json(settings);
  } catch (err) {
    return errorResponse(err, "api/departments");
  }
}
