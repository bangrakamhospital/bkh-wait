import { handlers } from "@/auth";

// Auth.js endpoints: /api/auth/signin/*, /callback/*, /signout, /csrf,
// /providers, /session (see src/auth.ts).
export const { GET, POST } = handlers;
