import "server-only";
import type { ExtensionContext } from "../extend/define";
import { getCmsConfig } from "../config";
import { HttpError } from "../http/errors";
import type { ApiKeyPrincipal, Principal, UserPrincipal } from "../authz/principal";
import { isOwnRecordPermission, scopeablePluginPermissions, scopedCollectionId, type Permission } from "../authz/permissions";
import { isScopeValue } from "./context";
import { isBasePath } from "../urls/base-path";
import { scopedCollectionIds } from "./registry";
import type { ScopeLimits } from "./limits";

/** What a scope provider sees of a request, to choose its value. */
export interface ScopeRequest {
  /** Lower-case, without a port. */
  host: string | null;
  headers: Headers;
  path: string;
  principal: Principal;
}

/**
 * Splits records by a value the plugin resolves per request, such as a tenant. Core enforces
 * it below grants and rules (SECURITY_MODEL.md, "Row scopes"). At most one plugin provides it.
 */
export interface ScopeProvider {
  /** What a value is called, such as "Tenant". Shown in errors and the dashboard. */
  label: string;
  /**
   * The value this request is for, or null for none. A hint: a value grants nothing by
   * itself, so it can come from a host, a header or a session. Throwing refuses the request.
   */
  resolve(request: ScopeRequest, context: ExtensionContext): string | null | Promise<string | null>;
  /** Whether the value exists and is active. A request for any other value is refused. */
  exists(value: string, context: ExtensionContext): boolean | Promise<boolean>;
  /**
   * The roles a signed-in person holds within this value. Only roles marked "scoped" under
   * Roles count, and core caps what they can hold. Throwing grants nothing.
   */
  rolesFor(principal: UserPrincipal | ApiKeyPrincipal, value: string, context: ExtensionContext): string[] | Promise<string[]>;
  /** Where existing records go when a collection that has some becomes scoped. */
  initial(context: ExtensionContext): string | Promise<string>;
  /** Every value that exists and is active, for jobs that run once per value (`perScope`). */
  values(context: ExtensionContext): string[] | Promise<string[]>;
  /**
   * The origin a value's site is served from, such as "https://acme.example", for links in
   * emails and feeds. Null, or left out, when the value has none of its own: links then start
   * at the instance's own address, with the value's `basePath` when it has one.
   */
  siteUrl?(value: string, context: ExtensionContext): string | null | Promise<string | null>;
  /**
   * The path prefix this value's site is served under on the instance's own address, such as
   * "/acme", or null (or left out) when it has none. The site layer strips it from the address
   * before matching a record and puts it back on every address it builds. One segment only.
   * Whether a request is under it is the site layer's business, not the provider's.
   */
  basePath?(value: string, context: ExtensionContext): string | null | Promise<string | null>;
  /**
   * What one value may use, such as a tenant's plan: records, bytes of files, API requests a
   * minute. Core enforces them. Null or left out for no limit. Read again every few seconds.
   */
  limits?(value: string, context: ExtensionContext): ScopeLimits | null | Promise<ScopeLimits | null>;
  /** Whether collections created through the API are scoped unless they say otherwise. Default true. */
  scopeNewCollections?: boolean;
  /**
   * The permission with which someone's instance roles reach any value, such as
   * "ext.multi-tenant:all". When set, a signed-in caller or API key with no role in the value
   * and without it is refused as if the value didn't exist. Left out, instance roles reach
   * every value.
   */
  everyValue?: Permission;
}

export interface ActiveScopeProvider {
  plugin: string;
  provider: ScopeProvider;
}

export function scopeProvider(): ActiveScopeProvider | null {
  const providers = (getCmsConfig().plugins ?? []).flatMap((plugin) => (plugin.scope ? [{ plugin: plugin.name, provider: plugin.scope }] : []));
  if (providers.length > 1) throw new Error(`Only one plugin can provide row scopes, and ${providers.map((entry) => entry.plugin).join(" and ")} both do.`);
  return providers[0] ?? null;
}

export function assertScopeProvider(): ActiveScopeProvider {
  const active = scopeProvider();
  if (!active) throw new HttpError(400, "NO_SCOPE_PROVIDER", "No plugin provides row scopes, so nothing can be scoped.");
  return active;
}

/** Whether a collection created through the API is scoped when it doesn't say. */
export function scopesNewCollections(): boolean {
  const active = scopeProvider();
  return active !== null && active.provider.scopeNewCollections !== false;
}

const contextFor = async (plugin: string) => (await import("../extend/hooks")).extensionContext(`plugin:${plugin}`);

/** The value existing rows go to when a collection becomes scoped. */
export async function initialScopeValue(): Promise<string> {
  const { plugin, provider } = assertScopeProvider();
  const value = await provider.initial(await contextFor(plugin));
  if (!isScopeValue(value)) throw new Error(`Plugin "${plugin}" gave "${String(value)}" as its first scope value, which isn't one.`);
  return value;
}

/** The origin of one value's own site, from the provider, or null when it has none. Only http(s) origins are passed on. */
async function scopeSiteOrigin(value: string): Promise<string | null> {
  const active = scopeProvider();
  if (!active?.provider.siteUrl) return null;
  const given = await active.provider.siteUrl(value, await contextFor(active.plugin));
  if (typeof given !== "string") return null;
  try {
    const url = new URL(given);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Where the current scope value's site begins, for absolute links in emails and feeds: the
 * origin of its own site when the provider names one, such as "https://acme.example", and
 * otherwise the instance's own address with the value's path prefix on the end, such as
 * "https://cms.example/acme" (MULTI_TENANT_PLAN.md, "A tenant's path prefix"). Null outside a
 * value, or when the value has neither.
 *
 * It can hold a path, so a path is joined onto it by writing one after the other:
 * `new URL(path, base)` drops a path on the base and would send the link to the wrong site.
 */
export async function scopeSiteUrl(): Promise<string | null> {
  const { currentScopeValue } = await import("./context");
  const value = currentScopeValue();
  if (value === null) return null;
  const own = await scopeSiteOrigin(value);
  if (own) return own;
  const base = await scopeBasePathOf(value);
  if (!base) return null;
  const { baseUrl } = await import("../http/request");
  // The instance's own address, never the Host header: these end up in email.
  const instance = baseUrl().replace(/\/+$/, "");
  return /^https?:\/\//.test(instance) ? `${instance}${base}` : null;
}

/**
 * The path prefix one value's site is served under, from the provider, or "" when it has none
 * or there is no provider. A prefix that isn't one path segment is left out.
 */
export async function scopeBasePathOf(value: string | null): Promise<string> {
  const active = scopeProvider();
  if (value === null || !active?.provider.basePath) return "";
  const given = await active.provider.basePath(value, await contextFor(active.plugin));
  if (given === null || given === undefined) return "";
  if (!isBasePath(given)) {
    console.warn(`[scope] ${active.plugin} gave ${JSON.stringify(given)} as ${value}'s base path, which isn't one path segment. It was left out.`);
    return "";
  }
  return given;
}

/** Every active value, for jobs that run once per value. Empty without a provider. Values that aren't one are left out. */
export async function everyScopeValue(): Promise<string[]> {
  const active = scopeProvider();
  if (!active) return [];
  const values = await active.provider.values(await contextFor(active.plugin));
  const valid = [...new Set(values)].filter(isScopeValue);
  if (valid.length !== values.length) console.warn(`[scope] ${active.plugin} listed scope values that aren't one, or listed one twice. They were left out.`);
  return valid;
}

/**
 * What a scoped role may hold. Everything else is instance-wide: changing the schema, roles,
 * users, settings, API keys, webhooks, every file. Redirects and a value's own site name,
 * logo and colour (`setting:site`) are kept per value, so a scoped role may read and manage its value's. Reading the schema
 * (`collection:read`) is allowed, because the schema is shared by every value and the
 * dashboard's record pages need it. Files stay out until they are scoped too, except
 * uploading, after which only the uploader and readers of the record can see one. Plugins
 * add their own permissions that mean something inside one value (`scopedPermissions`).
 */
const SCOPED_PERMISSION = /^(dashboard:access|collection:read|file:create|redirect:(read|manage)|setting:site|locale:edit(@.+)?|record:(list|read|create|update|delete|publish)(@c\d+(:own)?)?)$/;

export const isScopeablePermission = (permission: string) => SCOPED_PERMISSION.test(permission) || scopeablePluginPermissions().has(permission);

/**
 * A scoped role's permissions as they apply in one scope value: only what a scoped role may
 * hold, and record permissions only for scoped collections. A grant for every collection
 * becomes one for each scoped collection, so it never reaches a shared one.
 */
export function capScopedPermissions(held: Iterable<string>, scopedCollections: ReadonlySet<number> = scopedCollectionIds()): Set<string> {
  const out = new Set<string>();
  for (const permission of held) {
    if (!isScopeablePermission(permission)) continue;
    if (!permission.startsWith("record:")) {
      out.add(permission);
      continue;
    }
    const collection = scopedCollectionId(permission);
    if (collection !== null) {
      if (scopedCollections.has(collection)) out.add(permission);
      continue;
    }
    if (isOwnRecordPermission(permission)) continue;
    for (const id of scopedCollections) out.add(`${permission}@c${id}`);
  }
  return out;
}

export interface ResolvedScope {
  value: string;
  /** Role names the provider gave, of those marked scoped. */
  roles: string[];
}

/**
 * The scope a request is for, and the scoped roles its caller holds there. Null with no
 * provider or no value. Refuses a value that doesn't exist. An API key bound to a value is
 * for that value only: a request for another is refused, whatever chose it. Keys that
 * aren't bound get no scoped roles.
 */
export async function resolveScope(request: ScopeRequest, scopedRoles: ReadonlySet<string>, fixed?: string): Promise<ResolvedScope | null> {
  const active = scopeProvider();
  const { principal } = request;
  const bound = principal.kind === "apiKey" ? principal.boundScope ?? null : null;
  if (!active) {
    // A bound key whose provider is gone reaches nothing scoped, and is never widened to every value.
    if (bound !== null) throw new HttpError(403, "SCOPE_MISMATCH", "This API key is bound to a scope that no plugin provides now.");
    return null;
  }
  const context = await contextFor(active.plugin);
  const label = active.provider.label.toLowerCase();
  let value = fixed ?? await active.provider.resolve(request, context);
  if (bound !== null) {
    if (value === null || value === undefined) value = bound;
    else if (value !== bound) throw new HttpError(403, "SCOPE_MISMATCH", `This API key is for another ${label}.`);
  }
  if (value === null || value === undefined) return null;
  if (!isScopeValue(value) || !(await active.provider.exists(value, context))) throw new HttpError(404, "SCOPE_NOT_FOUND", `This ${label} doesn't exist.`);
  if (principal.kind === "anonymous") return { value, roles: [] };
  if (principal.kind === "apiKey" && bound === null) {
    if (active.provider.everyValue && !principal.permissions.has(active.provider.everyValue)) throw new HttpError(404, "SCOPE_NOT_FOUND", `This ${label} doesn't exist.`);
    return { value, roles: [] };
  }
  const given = await Promise.resolve(active.provider.rolesFor(principal, value, context)).catch((error: unknown) => {
    console.error(`[scope] ${active.plugin} could not list roles`, error);
    return [] as string[];
  });
  const roles = (Array.isArray(given) ? given : []).filter((name) => typeof name === "string" && scopedRoles.has(name));
  // A hint grants nothing: someone with no place in this value reaches it only with the provider's permission for every value.
  const { everyValue } = active.provider;
  if (!roles.length && everyValue && !principal.permissions.has(everyValue)) throw new HttpError(404, "SCOPE_NOT_FOUND", `This ${label} doesn't exist.`);
  return { value, roles };
}
