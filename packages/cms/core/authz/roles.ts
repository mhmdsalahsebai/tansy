import "server-only";
import type { Role } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { allPermissions, grants, type Permission } from "./permissions";

export const SUPERADMIN = "superadmin";
export const DEFAULT_USER_ROLE = "user";

const seedRoles: Array<Pick<Role, "name" | "label" | "description" | "system"> & { permissions: Permission[] }> = [
  { name: SUPERADMIN, label: "Superadmin", description: "Full access. Always holds every permission.", system: true, permissions: [] },
  {
    name: "admin",
    label: "Admin",
    description: "Manages users, content and schemas, but not roles or settings.",
    system: true,
    permissions: [
      "dashboard:access", "user:list", "user:get", "user:create", "user:update", "user:ban", "user:set-role",
      "session:list", "session:revoke", "role:list", "audit:read", "setting:read",
      "collection:read", "collection:create", "collection:update", "collection:delete", "collection:manage-rules",
      "record:list", "record:read", "record:create", "record:update", "record:delete", "record:publish", "locale:edit",
      "file:list", "file:read", "file:create", "file:update", "file:delete",
      "api-key:create", "api-key:list", "api-key:revoke",
    ],
  },
  {
    name: "editor",
    label: "Editor",
    description: "Creates and edits content in the dashboard.",
    system: true,
    permissions: ["dashboard:access", "collection:read", "record:list", "record:read", "record:create", "record:update", "record:delete", "locale:edit", "file:list", "file:read", "file:create", "file:update", "file:delete"],
  },
  {
    name: "reviewer",
    label: "Reviewer",
    description: "Edits content, and approves and publishes changes in collections that require review.",
    system: true,
    permissions: ["dashboard:access", "collection:read", "record:list", "record:read", "record:create", "record:update", "record:delete", "record:publish", "locale:edit", "file:list", "file:read", "file:create", "file:update", "file:delete"],
  },
  { name: DEFAULT_USER_ROLE, label: "User", description: "Application end user. No dashboard access.", system: true, permissions: [] },
];

export type RoleMap = Map<string, Set<string>>;

/** Stored as JSON, so anything malformed grants nothing. */
export const rolePermissions = (role: Pick<Role, "permissions">): string[] =>
  Array.isArray(role.permissions) ? role.permissions.filter((p): p is string => typeof p === "string") : [];

export async function loadRoles(): Promise<Role[]> {
  const existing = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  if (existing.some((role) => role.name === SUPERADMIN)) return existing;
  const present = new Set(existing.map((role) => role.name));
  // Two first requests can seed at once. Losing that race is fine.
  await prisma.role.createMany({ data: seedRoles.filter((role) => !present.has(role.name)) }).catch((error) => {
    if ((error as { code?: string }).code !== "P2002") throw error;
  });
  return prisma.role.findMany({ orderBy: { createdAt: "asc" } });
}

/** Instance roles. A scoped role is listed with nothing, so holding it as someone's instance role grants nothing. */
export function buildRoleMap(roles: Role[]): RoleMap {
  return new Map(
    roles.map((role) => [role.name, new Set<string>(role.name === SUPERADMIN ? allPermissions() : role.scope === SCOPED_ROLE ? [] : rolePermissions(role))]),
  );
}

/** Roles a scope provider gives within one scope value (core/scope), with what each holds before capping. */
export function buildScopedRoleMap(roles: Role[]): RoleMap {
  return new Map(roles.filter((role) => role.scope === SCOPED_ROLE).map((role) => [role.name, new Set(rolePermissions(role))]));
}

export const SCOPED_ROLE = "scoped";

/** better-auth stores multiple roles comma-separated. Unknown roles grant nothing. */
export function parseRoleNames(role: string | null | undefined): string[] {
  return (role ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

export function permissionsForRole(map: RoleMap, role: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const name of parseRoleNames(role)) {
    for (const permission of map.get(name) ?? []) out.add(permission);
  }
  return out;
}

/**
 * What someone holds that a role also grants: never more than either. A global grant on one
 * side and a collection's on the other give the collection's, as `grants` reads them.
 */
export function withinRole(held: ReadonlySet<string>, role: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const permission of held) if (grants(role, permission)) out.add(permission);
  for (const permission of role) if (grants(held, permission)) out.add(permission);
  return out;
}

/** Every permission in `subset` is covered by `superset`, where `record:update` covers `record:update@c3`. */
export function isSubset(subset: Iterable<string>, superset: Set<string>): boolean {
  for (const item of subset) if (!grants(superset, item)) return false;
  return true;
}
