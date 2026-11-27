import { getSession, sessionInfo } from "@/lib/auth/session";
import { errorResponse, json } from "@/lib/http";

// Current user with the role re-read from the user store (null = signed out).
export async function GET() {
  try {
    const session = await getSession();
    return json({ user: session ? sessionInfo(session) : null });
  } catch (err) {
    return errorResponse(err, "api/session");
  }
}
