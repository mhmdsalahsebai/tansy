import { z } from "zod";
import { setUserValues, userFieldValues } from "../../../../../core/auth/user-fields";
import { assertCanManage } from "../../../../../core/auth/users";
import { route } from "../../../../../core/authz/guard";

export const GET = route({ access: "permission", permission: "user:get" }, async ({ params }) => userFieldValues(params.id, { includeHidden: true }));

const body = z.object({ values: z.record(z.string(), z.unknown()) });

export const PUT = route(
  { access: "permission", permission: "user:update", body, audit: "user.update_fields", fresh: true, maxBodyBytes: 64 * 1024 },
  async ({ params, body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    await assertCanManage(principal, params.id, runtime);
    // Names only. These values can be anything, so they stay out of the audit log.
    auditTarget("user", params.id, { fields: Object.keys(body.values).slice(0, 100) });
    await setUserValues(params.id, body.values);
    return userFieldValues(params.id, { includeHidden: true });
  },
);
