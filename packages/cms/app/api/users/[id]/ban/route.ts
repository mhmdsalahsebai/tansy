import { headers } from "next/headers";
import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { assertCanManage, assertNotLastSuperadmin } from "../../../../../core/auth/users";

const body = z.object({ reason: z.string().trim().max(500).optional(), expiresInDays: z.number().int().min(1).max(3650).optional() });

export const POST = route(
  { access: "permission", permission: "user:ban", body, audit: "user.ban" },
  async ({ params, body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    const target = await assertCanManage(principal, params.id, runtime);
    await assertNotLastSuperadmin(target);
    auditTarget("user", params.id, { reason: body.reason });
    await runtime.auth.api.banUser({
      headers: await headers(),
      body: { userId: params.id, banReason: body.reason, banExpiresIn: body.expiresInDays ? body.expiresInDays * 86_400 : undefined },
    });
    return null;
  },
);

export const DELETE = route(
  { access: "permission", permission: "user:ban", audit: "user.unban" },
  async ({ params, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    await assertCanManage(principal, params.id, runtime);
    auditTarget("user", params.id);
    await runtime.auth.api.unbanUser({ headers: await headers(), body: { userId: params.id } });
    return null;
  },
);
