import { headers } from "next/headers";
import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { assertCanManage, assertNotLastSuperadmin } from "../../../../core/auth/users";
import { notFound } from "../../../../core/http/errors";

export const GET = route({ access: "permission", permission: "user:get" }, async ({ params, runtime }) => {
  const user = await runtime.auth.api.getUser({ headers: await headers(), query: { id: params.id } }).catch(() => null);
  if (!user) throw notFound("User");
  return user;
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.email().optional(),
  emailVerified: z.boolean().optional(),
});

export const PATCH = route(
  { access: "permission", permission: "user:update", body: updateBody, audit: "user.update", fresh: true },
  async ({ params, body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    await assertCanManage(principal, params.id, runtime);
    auditTarget("user", params.id, { fields: Object.keys(body) });
    return runtime.auth.api.adminUpdateUser({ headers: await headers(), body: { userId: params.id, data: body } });
  },
);

export const DELETE = route(
  { access: "permission", permission: "user:delete", audit: "user.delete", fresh: true },
  async ({ params, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    const target = await assertCanManage(principal, params.id, runtime);
    await assertNotLastSuperadmin(target);
    auditTarget("user", params.id, { email: target.email });
    await runtime.auth.api.removeUser({ headers: await headers(), body: { userId: params.id } });
    return null;
  },
);
