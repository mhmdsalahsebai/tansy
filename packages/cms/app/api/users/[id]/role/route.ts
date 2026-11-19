import { headers } from "next/headers";
import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { assertCanManage, assertNotLastSuperadmin, assertRoleAssignable } from "../../../../../core/auth/users";
import { SUPERADMIN } from "../../../../../core/authz/roles";

export const PUT = route(
  { access: "permission", permission: "user:set-role", body: z.object({ role: z.string().min(1) }), audit: "user.set_role", fresh: true },
  async ({ params, body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    const target = await assertCanManage(principal, params.id, runtime);
    assertRoleAssignable(principal, body.role, runtime);
    if (body.role !== SUPERADMIN) await assertNotLastSuperadmin(target);
    auditTarget("user", params.id, { from: target.role, to: body.role });
    await runtime.auth.api.setRole({ headers: await headers(), body: { userId: params.id, role: body.role as "user" } });
    // OWASP: a privilege change ends existing sessions.
    await runtime.auth.api.revokeUserSessions({ headers: await headers(), body: { userId: params.id } });
    return null;
  },
);
