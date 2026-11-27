/**
 * User-management types shared by the admin API (server) and the
 * /admin/users page (client). Pure module.
 *
 *   GET   /api/admin/users        -> 200 AdminUsersResponse
 *   PATCH /api/admin/users/{sub}  -> 200 { user: AdminUser }
 *   errors                        -> { error, code } (docs/api.md)
 */

export const USER_STATUSES = ["pending", "approved", "rejected"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_ROLES = ["admin", "staff"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface UserDecision {
  /** Principal id of the deciding admin, or "system". */
  sub: string;
  name: string;
}

/** One Provider ID account. No citizen ID, email or patient data. */
export interface AdminUser {
  sub: string;
  name: string;
  orgCode: string;
  orgName: string;
  jobPosition: string;
  status: UserStatus;
  role: UserRole;
  /** Listed in AUTH_ADMIN_SUBS: always an approved admin, not changeable in the UI. */
  envAdmin: boolean;
  createdAt: string;
  lastLoginAt: string;
  loginCount: number;
  decidedBy: UserDecision | null;
  decidedAt: string | null;
}

export interface AdminUsersResponse {
  /** Pending first, then lastLoginAt descending. */
  users: AdminUser[];
  /** The signed-in admin's Provider ID sub ("" for a WAIT_USERS admin). */
  me: { sub: string };
}

export interface AdminUserPatch {
  status?: UserStatus;
  role?: UserRole;
}
