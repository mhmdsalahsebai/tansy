import { headers } from "next/headers";
import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { assertCanManage, assertPasswordAcceptable } from "../../../../../core/auth/users";

export const PUT = route(
  { access: "permission", permission: "user:set-password", body: z.object({ password: z.string().min(1).max(256) }), audit: "user.set_password", fresh: true },
  async ({ params, body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    await assertCanManage(principal, params.id, runtime);
    await assertPasswordAcceptable(body.password, runtime);
    auditTarget("user", params.id);
    await runtime.auth.api.setUserPassword({ headers: await headers(), body: { userId: params.id, newPassword: body.password } });
    await runtime.auth.api.revokeUserSessions({ headers: await headers(), body: { userId: params.id } });
    return null;
  },
);
