import { adminGate, toAdminUser } from "@/lib/admin/api";
import { errorResponse, json } from "@/lib/http";
import { listUsers } from "@/lib/users/store";
import type { AdminUsersResponse } from "@/lib/users/types";

// GET /api/admin/users -> { users, me } (admin only).
export async function GET() {
  try {
    const admin = await adminGate();
    const users = await listUsers();
    const body: AdminUsersResponse = { users: users.map(toAdminUser), me: { sub: admin.sub ?? "" } };
    return json(body);
  } catch (err) {
    return errorResponse(err, "api/admin/users");
  }
}
