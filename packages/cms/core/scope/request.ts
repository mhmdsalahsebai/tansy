import "server-only";
import type { AuthRuntime } from "../auth/instance";
import type { Principal } from "../authz/principal";
import { HttpError } from "../http/errors";
import { grants } from "../authz/permissions";
import { capScopedPermissions, resolveScope, scopeProvider, type ResolvedScope } from "./provider";

/** The request's host, lower-case and without a port. */
export function hostOf(headers: Headers): string | null {
  const host = headers.get("host")?.trim().toLowerCase();
  if (!host) return null;
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/** The caller as they act within a resolved scope: their instance permissions, and their capped scoped roles there. */
function within(principal: Principal, resolved: ResolvedScope | null, runtime: AuthRuntime, member: boolean): Principal {
  if (!resolved) return { ...principal, scope: null };
  // Reading as a member only ever takes permissions away, so scoped roles don't apply either.
  if (member) return { ...principal, scope: resolved.value };
  const held = new Set<string>();
  for (const name of resolved.roles) for (const permission of runtime.scopedRoles.get(name) ?? []) held.add(permission);
  const capped = capScopedPermissions(held);
  return { ...principal, scope: resolved.value, permissions: new Set([...principal.permissions, ...(principal.kind === "apiKey" ? withinKey(capped, principal.requested) : capped)]) };
}

/** A key holds its owner's scoped permissions only as far as it was given them, either way round. */
function withinKey(capped: ReadonlySet<string>, requested: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const permission of capped) if (grants(requested, permission)) out.add(permission);
  for (const permission of requested) if (grants(capped, permission)) out.add(permission);
  return out;
}

/**
 * Resolves the scope a request is for, through the installed provider, and the permissions
 * its caller holds there. Without a provider the request has no scope, so scoped collections
 * left behind by a removed provider refuse it.
 */
export async function scopePrincipal(request: { headers: Headers; path: string }, principal: Principal, runtime: AuthRuntime, member: boolean): Promise<Principal> {
  const resolved = await resolveScope({ host: hostOf(request.headers), headers: request.headers, path: request.path, principal }, new Set(runtime.scopedRoles.keys()));
  return within(principal, resolved, runtime, member);
}

/**
 * The caller in a scope value fixed earlier, such as a realtime connection's, with roles read
 * again so a removed membership takes effect. Null when the value no longer exists.
 */
export async function principalInScope(principal: Principal, value: string | null, runtime: AuthRuntime, member: boolean): Promise<Principal | null> {
  if (value === null) return { ...principal, scope: null };
  const active = scopeProvider();
  if (!active) return null;
  const resolved = await resolveScope({ host: null, headers: new Headers(), path: "", principal }, new Set(runtime.scopedRoles.keys()), value).catch((error: unknown) => {
    if (error instanceof HttpError) return null;
    throw error;
  });
  return resolved ? within(principal, resolved, runtime, member) : null;
}
