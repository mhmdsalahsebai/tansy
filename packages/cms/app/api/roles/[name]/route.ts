import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { removeRole, updateRole } from "../../../../core/authz/role-admin";

const body = z.object({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).max(500),
  scope: z.enum(["instance", "scoped"]).optional(),
});

export const PUT = route(
  { access: "permission", permission: "role:update", body, audit: "role.update", fresh: true },
  async ({ params, body, principal, auditTarget }) => {
    auditTarget("role", params.name, { permissions: body.permissions });
    return updateRole(principal.permissions, params.name, body);
  },
);

export const DELETE = route(
  { access: "permission", permission: "role:delete", audit: "role.delete", fresh: true },
  async ({ params, principal, auditTarget }) => {
    auditTarget("role", params.name);
    await removeRole(principal.permissions, params.name);
    return null;
  },
);
