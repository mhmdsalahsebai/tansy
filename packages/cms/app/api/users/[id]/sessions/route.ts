import { headers } from "next/headers";
import { route } from "../../../../../core/authz/guard";
import { assertCanManage } from "../../../../../core/auth/users";

export const GET = route({ access: "permission", permission: "session:list" }, async ({ params, runtime }) => {
  const { sessions } = await runtime.auth.api.listUserSessions({ headers: await headers(), body: { userId: params.id } });
  // The token is a credential: dashboards only need the metadata.
  return sessions.map(({ id, createdAt, expiresAt, ipAddress, userAgent, impersonatedBy }) => ({ id, createdAt, expiresAt, ipAddress, userAgent, impersonatedBy }));
});

export const DELETE = route(
  { access: "permission", permission: "session:revoke", audit: "user.revoke_sessions" },
  async ({ params, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    await assertCanManage(principal, params.id, runtime);
    auditTarget("user", params.id);
    await runtime.auth.api.revokeUserSessions({ headers: await headers(), body: { userId: params.id } });
    return null;
  },
);
