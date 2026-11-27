import { adminActor, adminGate } from "@/lib/admin/api";
import { accessCodeHashingReady } from "@/lib/access-codes/code";
import { createAccessCode, listAccessCodes, toAccessCodeView } from "@/lib/access-codes/store";
import {
  ACCESS_CODE_MAX_DAYS,
  ACCESS_CODE_NAME_MAX,
  ACCESS_CODE_ORG_MAX,
  accessCodeExpiry,
  addDays,
  bangkokToday,
  type AccessCodeCreateResponse,
} from "@/lib/access-codes/types";
import { cleanField } from "@/lib/auth/request";
import { ApiError, errorResponse, json, readJsonBody, validation } from "@/lib/http";

// GET  /api/admin/access-codes -> { codes } (newest first, never hashes)
// POST /api/admin/access-codes { name, org, expiresOn: "YYYY-MM-DD" (Bangkok) }
//   -> 201 { code, plaintext } — the plaintext is returned ONLY here.

export async function GET() {
  try {
    await adminGate();
    const now = Date.now();
    return json({ codes: (await listAccessCodes()).map((r) => toAccessCodeView(r, now)) });
  } catch (err) {
    return errorResponse(err, "api/admin/access-codes");
  }
}

function parseCreate(body: Record<string, unknown>, now = new Date()) {
  if (Object.keys(body).some((k) => k !== "name" && k !== "org" && k !== "expiresOn")) {
    throw validation("ข้อมูลที่ส่งมาไม่ถูกต้อง");
  }
  const name = cleanField(body.name, ACCESS_CODE_NAME_MAX + 1);
  if (!name || name.length > ACCESS_CODE_NAME_MAX) throw validation(`กรุณาระบุชื่อ (1-${ACCESS_CODE_NAME_MAX} ตัวอักษร)`);
  const org = cleanField(body.org, ACCESS_CODE_ORG_MAX + 1);
  if (!org || org.length > ACCESS_CODE_ORG_MAX) throw validation(`กรุณาระบุหน่วยงาน (1-${ACCESS_CODE_ORG_MAX} ตัวอักษร)`);
  const day = body.expiresOn;
  const today = bangkokToday(now);
  if (
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
    // rejects impossible dates such as 2026-02-30
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day ||
    day < today ||
    day > addDays(today, ACCESS_CODE_MAX_DAYS)
  ) {
    throw validation(`วันหมดอายุต้องอยู่ระหว่างวันนี้ถึง ${ACCESS_CODE_MAX_DAYS} วันข้างหน้า`);
  }
  return { name, org, expiresAt: accessCodeExpiry(day, now) };
}

export async function POST(request: Request) {
  try {
    const admin = await adminGate();
    const input = parseCreate(await readJsonBody(request));
    if (!accessCodeHashingReady()) {
      throw new ApiError(503, "AUTH_NOT_CONFIGURED", "ยังสร้างรหัสไม่ได้: ยังไม่ได้ตั้งค่า WAIT_ACCESS_CODE_SECRET / AUTH_SECRET");
    }
    const result = await createAccessCode(input, adminActor(admin));
    if (!result.ok) throw new ApiError(409, "CONFLICT", "จำนวนรหัสที่ใช้งานอยู่เกินที่ระบบกำหนด");
    const body: AccessCodeCreateResponse = { code: toAccessCodeView(result.record), plaintext: result.plaintext };
    return json(body, 201);
  } catch (err) {
    return errorResponse(err, "api/admin/access-codes");
  }
}
