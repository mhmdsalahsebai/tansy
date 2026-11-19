import "server-only";
import type { AuthRuntime } from "../auth/instance";
import { bumpAuthRevision } from "../auth/settings";
import { invalidateRuntime } from "../auth/instance";
import { HttpError, notFound } from "../http/errors";
import prisma from "../../lib/prisma";
import { audit } from "../audit";
import type { PluginRole } from "../extend/define";
import { isKnownPermission, isOwnRecordPermission, scopedCollectionId } from "./permissions";
import { DEFAULT_USER_ROLE, isSubset, rolePermissions, SCOPED_ROLE, SUPERADMIN } from "./roles";
import { isScopeablePermission } from "../scope/provider";
import { isLocalePermission } from "../i18n/permissions";
import { listLocales } from "../i18n/locales";

export async function listRoles(runtime: AuthRuntime) {
  const roles = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  const users = await prisma.user.groupBy({ by: ["role"], _count: true });
  const counts = new Map(users.map((row) => [row.role, row._count]));
  return roles.map((role) => ({
    ...role,
    permissions: [...((role.scope === SCOPED_ROLE ? runtime.scopedRoles : runtime.roles).get(role.name) ?? [])],
    userCount: counts.get(role.name) ?? 0,
    immutable: role.name === SUPERADMIN,
  }));
}

/** Role identifiers, as better-auth stores them in a user's comma-separated role. */
export const ROLE_NAME = /^[a-z][a-z0-9_-]{1,39}$/;

async function assertValidPermissions(permissions: string[]) {
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw new HttpError(400, "UNKNOWN_PERMISSION", `Unknown permissions: ${unknown.join(", ")}`);
  const languages = permissions.filter(isLocalePermission);
  if (languages.length) {
    const known = new Set((await listLocales()).map((locale) => locale.code));
    const missingLanguages = languages.filter((p) => !known.has(p.slice("locale:edit@".length)));
    if (missingLanguages.length) throw new HttpError(400, "UNKNOWN_PERMISSION", `Unknown permissions: ${missingLanguages.join(", ")}`);
  }
  // A grant for a missing collection would wait for one that never comes, so refuse it.
  const ids = [...new Set(permissions.map(scopedCollectionId).filter((id): id is number => id !== null))];
  if (!ids.length) return;
  const found = new Map((await prisma.collection.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })).map((c) => [c.id, c.type]));
  const missing = permissions.filter((p) => { const id = scopedCollectionId(p); return id !== null && !found.has(id); });
  if (missing.length) throw new HttpError(400, "UNKNOWN_PERMISSION", `Unknown permissions: ${missing.join(", ")}`);
  // A view's rows have no creator, so an own grant there would never match.
  const onViews = permissions.filter((p) => isOwnRecordPermission(p) && found.get(scopedCollectionId(p)!) === "view");
  if (onViews.length) throw new HttpError(400, "UNKNOWN_PERMISSION", `View collections have no own records: ${onViews.join(", ")}`);
}

async function assertGrantable(actor: Set<string>, permissions: string[]) {
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw new HttpError(400, "UNKNOWN_PERMISSION", `Unknown permissions: ${unknown.join(", ")}`);
  if (!isSubset(permissions, actor)) throw new HttpError(403, "ROLE_EXCEEDS_ACTOR", "You cannot grant permissions you do not hold.");
  await assertValidPermissions(permissions);
}

/**
 * Drops roles' grants for deleted collections. Ids are never reused on either
 * database, so a leftover grant would match nothing; this keeps roles tidy.
 */
export async function removeCollectionGrants(collectionIds: number[]) {
  const gone = new Set(collectionIds);
  let changed = false;
  for (const role of await prisma.role.findMany()) {
    const permissions = rolePermissions(role);
    const kept = permissions.filter((p) => { const id = scopedCollectionId(p); return id === null || !gone.has(id); });
    if (kept.length === permissions.length) continue;
    await prisma.role.update({ where: { name: role.name }, data: { permissions: kept } });
    changed = true;
  }
  if (changed) await applied();
}

async function applied() {
  await bumpAuthRevision();
  invalidateRuntime();
}

export type RoleScope = "instance" | typeof SCOPED_ROLE;

interface RoleInput { label: string; description?: string; permissions: string[]; scope?: RoleScope }

/**
 * A scoped role applies only within one row scope value, given by the scope provider
 * (core/scope). It may hold only what makes sense inside one: dashboard access, records,
 * languages and uploading files. Everything else is instance-wide.
 */
function assertScopeable(permissions: string[]) {
  const instanceOnly = permissions.filter((permission) => !isScopeablePermission(permission));
  if (instanceOnly.length) throw new HttpError(400, "NOT_SCOPEABLE", `A scoped role can't hold instance-wide permissions: ${instanceOnly.join(", ")}`);
}

export async function saveNewRole(actor: Set<string>, input: RoleInput & { name: string }) {
  await assertGrantable(actor, input.permissions);
  if (input.scope === SCOPED_ROLE) assertScopeable(input.permissions);
  if (await prisma.role.findUnique({ where: { name: input.name } })) throw new HttpError(409, "CONFLICT", "A role with that name already exists.");
  const role = await prisma.role.create({ data: input });
  await applied();
  return role;
}

export async function updateRole(actor: Set<string>, name: string, input: RoleInput) {
  const existing = await prisma.role.findUnique({ where: { name } });
  if (!existing) throw notFound("Role");
  if (name === SUPERADMIN) throw new HttpError(400, "ROLE_IMMUTABLE", "The superadmin role cannot be changed.");
  // A permission that no longer exists, such as one of a removed plugin, grants nothing. It's
  // dropped when the role is saved, so the dashboard sending back what it read doesn't fail.
  const held = rolePermissions(existing);
  const stale = new Set(held.filter((p) => !isKnownPermission(p)));
  input = { ...input, permissions: input.permissions.filter((p) => !stale.has(p)) };
  await assertGrantable(actor, input.permissions);
  // Moving a role between instance and scoped would change what everyone holding it can reach, so it's fixed when created.
  if (input.scope !== undefined && input.scope !== existing.scope) throw new HttpError(400, "ROLE_SCOPE_FIXED", "A role's scope can't change. Create a new role instead.");
  if (existing.scope === SCOPED_ROLE) assertScopeable(input.permissions);
  input = { label: input.label, description: input.description, permissions: input.permissions };
  // Changing a role you could not have granted would be escalation by the back door.
  if (!isSubset(held.filter((p) => !stale.has(p)), actor)) throw new HttpError(403, "ROLE_EXCEEDS_ACTOR", "You cannot edit a role with more privileges than your own.");
  if (name === DEFAULT_USER_ROLE && input.permissions.includes("dashboard:access")) {
    throw new HttpError(400, "VALIDATION_FAILED", "The default user role cannot have dashboard access.");
  }
  const role = await prisma.role.update({ where: { name }, data: input });
  await applied();
  return role;
}

export async function removeRole(actor: Set<string>, name: string) {
  const existing = await prisma.role.findUnique({ where: { name } });
  if (!existing) throw notFound("Role");
  if (existing.system) throw new HttpError(400, "ROLE_IMMUTABLE", "Built-in roles cannot be deleted.");
  if (!isSubset(rolePermissions(existing), actor)) throw new HttpError(403, "ROLE_EXCEEDS_ACTOR", "You cannot delete a role with more privileges than your own.");
  if ((await prisma.user.count({ where: { role: name } })) > 0) throw new HttpError(409, "ROLE_IN_USE", "Move users off this role before deleting it.");
  await prisma.role.delete({ where: { name } });
  await applied();
}

const RECORD_GRANT = /^(list|read|create|update|delete|publish)(:own)?$/;

/**
 * Creates a plugin's role if there's no role by that name. An existing one is left as it is,
 * because owners can change a plugin's role like any other. Grants name collections by slug,
 * stored by id as the role editor stores them. Nobody holds the role until someone with
 * enough permissions assigns it, so the usual limits on granting still apply then.
 */
export async function ensurePluginRole(plugin: string, role: PluginRole): Promise<boolean> {
  const fail = (problem: string): never => { throw new Error(`role "${role.name}": ${problem}`); };
  if (!ROLE_NAME.test(role.name) || !role.name.startsWith(`${plugin}-`)) fail(`the name must start with "${plugin}-", then lowercase letters, numbers, - or _, up to 40 characters.`);
  const label = role.label?.trim() ?? "";
  if (!label || label.length > 80) fail("needs a label of up to 80 characters.");
  const description = role.description?.trim() || null;
  if (description && description.length > 300) fail("the description can be up to 300 characters.");
  if (await prisma.role.findUnique({ where: { name: role.name } })) return false;
  const scope = role.scope ?? "instance";
  if (scope !== "instance" && scope !== SCOPED_ROLE) fail(`the scope must be "instance" or "${SCOPED_ROLE}".`);

  const slugs = Object.keys(role.records ?? {});
  const ids = new Map((await prisma.collection.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } })).map((c) => [c.slug, c.id]));
  const records = Object.entries(role.records ?? {}).flatMap(([slug, grants]) => {
    const id = ids.get(slug) ?? fail(`there's no collection "${slug}".`);
    return grants.map((grant) => {
      const match = RECORD_GRANT.exec(grant);
      if (!match || ((match[1] === "create" || match[1] === "publish") && match[2])) fail(`"${grant}" in "${slug}" isn't a record grant. Use list, read, create, update, delete or publish, optionally with :own, except create and publish.`);
      return `record:${match![1]}@c${id}${match![2] ?? ""}`;
    });
  });
  const permissions = [...new Set([...(role.permissions ?? []), ...records])];
  try {
    await assertValidPermissions(permissions);
    if (scope === SCOPED_ROLE) assertScopeable(permissions);
  } catch (error) {
    fail((error as Error).message);
  }

  try {
    await prisma.role.create({ data: { name: role.name, label, description, permissions, system: false, scope } });
  } catch (error) {
    // Another instance starting at the same time created it first.
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
  await audit({ action: "role.create", outcome: "success", actorKind: "system", actorEmail: `plugin:${plugin}`, targetType: "role", targetId: role.name, metadata: { permissions } });
  await applied();
  return true;
}
