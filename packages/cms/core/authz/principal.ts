import "server-only";
import type { AuthRuntime } from "../auth/instance";
import { ruleValues } from "../auth/user-fields";
import prisma from "../../lib/prisma";
import { allPermissions, fromStatements, grants, type Permission } from "./permissions";
import { permissionsForRole } from "./roles";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Base {
  permissions: Set<string>;
  /**
   * The row scope value a request is for (core/scope), null for a request with none. Absent for
   * trusted server work, which the record layer scopes on its own.
   */
  scope?: string | null;
  /** Custom user fields for API rules, hidden ones included. Kept off `user` so it can't be returned by accident. */
  custom?: Record<string, unknown>;
}
export interface AnonymousPrincipal extends Base {
  kind: "anonymous";
  /** On a plugin's `system.records`, who it is, such as plugin:shop. Only it writes its system-owned collections. */
  system?: string;
}
export interface UserPrincipal extends Base {
  kind: "user";
  user: AuthUser;
  session: { id: string; createdAt: Date; impersonatedBy: string | null };
}
export interface ApiKeyPrincipal extends Base {
  kind: "apiKey";
  user: AuthUser;
  keyId: string;
  /**
   * The row scope value the key is bound to, if any (core/scope). Its requests are for that value
   * only, and it holds its owner's scoped roles there, within `requested`.
   */
  boundScope?: string | null;
  /** What the key was given when created, before limiting it to what its owner holds now. */
  requested?: ReadonlySet<string>;
}
export type Principal = AnonymousPrincipal | UserPrincipal | ApiKeyPrincipal;

export const ANONYMOUS: AnonymousPrincipal = { kind: "anonymous", permissions: new Set() };

/** For hooks and jobs, which are trusted server code. Creates records with no owner. Only core/extend hands this out, and never to a request. */
export const systemPrincipal = (source?: string): AnonymousPrincipal => ({ kind: "anonymous", permissions: new Set(allPermissions()), ...(source ? { system: source } : {}) });

export const can = (principal: Principal, permission: Permission) => principal.permissions.has(permission);

/**
 * A signed-in person as a member of the public site: who they are, for API rules
 * through @request.auth, and none of their role's permissions. Staff then see a
 * members' page as any member would, never drafts or hidden fields their role
 * could read. Null for anyone not signed in with a session.
 */
export function memberPrincipal(principal: Principal): UserPrincipal | null {
  if (principal.kind !== "user") return null;
  return { ...principal, permissions: new Set() };
}

function toAuthUser(user: Record<string, unknown>): AuthUser {
  return {
    id: String(user.id),
    email: String(user.email),
    name: String(user.name),
    role: (user.role as string | null | undefined) ?? null,
    emailVerified: Boolean(user.emailVerified),
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
    createdAt: new Date(user.createdAt as string | Date),
    updatedAt: new Date(user.updatedAt as string | Date),
  };
}

export const isBanned = (user: { banned?: boolean | null; banExpires?: Date | null }) =>
  Boolean(user.banned) && (!user.banExpires || new Date(user.banExpires) > new Date());

export async function principalFromSession(headers: Headers, runtime: AuthRuntime): Promise<Principal> {
  const result = await runtime.auth.api
    .getSession({ headers, query: { disableCookieCache: true } })
    .catch(() => null);
  if (!result || isBanned(result.user)) return ANONYMOUS;

  // better-auth's expiry slides with activity; this is the hard upper bound OWASP asks for.
  const ageSeconds = (Date.now() - new Date(result.session.createdAt).getTime()) / 1000;
  if (ageSeconds > runtime.settings.session.absoluteTimeout) {
    await prisma.session.deleteMany({ where: { id: result.session.id } });
    return ANONYMOUS;
  }

  return {
    kind: "user",
    user: toAuthUser(result.user),
    session: {
      id: result.session.id,
      createdAt: new Date(result.session.createdAt),
      impersonatedBy: result.session.impersonatedBy ?? null,
    },
    permissions: permissionsForRole(runtime.roles, result.user.role),
    custom: await ruleValues(result.user.id),
  };
}

export async function principalFromApiKey(key: string, runtime: AuthRuntime): Promise<ApiKeyPrincipal | null> {
  if (!runtime.settings.apiKeys.enabled) return null;
  const result = await runtime.auth.api.verifyApiKey({ body: { key } }).catch(() => null);
  if (!result?.valid || !result.key) return null;
  const owner = await prisma.user.findUnique({ where: { id: result.key.referenceId } });
  if (!owner || isBanned(owner)) return null;
  // A key can never exceed its owner, including after the owner's role is reduced.
  const ownerPermissions = permissionsForRole(runtime.roles, owner.role);
  const granted = fromStatements(result.key.permissions as Record<string, string[]> | null);
  const metadata = result.key.metadata as { scope?: unknown } | null | undefined;
  return {
    kind: "apiKey",
    user: toAuthUser(owner),
    keyId: result.key.id,
    permissions: new Set([...granted].filter((p) => grants(ownerPermissions, p))),
    boundScope: typeof metadata?.scope === "string" ? metadata.scope : null,
    requested: granted,
    custom: await ruleValues(owner.id),
  };
}

/** For work done later on someone's behalf. Uses their access as it stands now, and is null if they are gone or banned. */
export async function principalForUser(userId: string, runtime: AuthRuntime, keyId: string): Promise<ApiKeyPrincipal | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || isBanned(user)) return null;
  return { kind: "apiKey", user: toAuthUser(user), keyId, permissions: permissionsForRole(runtime.roles, user.role), custom: await ruleValues(user.id) };
}
