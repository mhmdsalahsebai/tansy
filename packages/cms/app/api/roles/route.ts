import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { allStatements, resourceLabels } from "../../../core/authz/permissions";
import { listRoles, ROLE_NAME, saveNewRole } from "../../../core/authz/role-admin";
import { listCollectionNames } from "../../../core/content/collections";
import { listLocales } from "../../../core/i18n/locales";
import { isScopeablePermission, scopeProvider } from "../../../core/scope/provider";

export const GET = route({ access: "permission", permission: "role:list" }, async ({ runtime, principal }) => {
  const statements = Object.entries(allStatements());
  const provider = scopeProvider();
  return {
    roles: await listRoles(runtime),
    catalogue: statements.map(([resource, actions]) => ({
      resource,
      label: resourceLabels[resource] ?? resource,
      actions: [...actions],
    })),
    // With a scope provider, roles can apply within one of its values, and hold only these there.
    scope: provider ? {
      plugin: provider.plugin,
      label: provider.provider.label,
      permissions: statements.flatMap(([resource, actions]) => [...actions].map((action) => `${resource}:${action}`)).filter(isScopeablePermission),
    } : null,
    // For per-collection record grants. Names only, and only to those who may read schemas.
    collections: principal.permissions.has("collection:read") ? await listCollectionNames() : [],
    // For per-language grants, locale:edit@<code>.
    locales: (await listLocales()).map(({ code, label }) => ({ code, label })),
  };
});

const body = z.object({
  name: z.string().trim().regex(ROLE_NAME, "Use lowercase letters, numbers, - or _."),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).max(500),
  /** "scoped": given by the scope provider within one scope value, never as someone's own role. */
  scope: z.enum(["instance", "scoped"]).optional(),
});

export const POST = route(
  { access: "permission", permission: "role:create", body, audit: "role.create", fresh: true },
  async ({ body, principal, auditTarget }) => {
    auditTarget("role", body.name, { permissions: body.permissions, scope: body.scope ?? "instance" });
    return saveNewRole(principal.permissions, body);
  },
);
