import { adminPath, apiPath, type ExtensionContext } from "tansy/plugin";
import { listTenants, TENANT_SLUG } from "./tenants";

/**
 * Where a tenant's site sits when it has no domain of its own: under its short name on the
 * instance's own address, such as /acme/blog/hello. Core strips the prefix before it matches
 * an address and puts it back on every address it builds (`basePath` on the scope provider).
 *
 * A verified domain still decides for everyone, so the prefix is read only on a host no tenant
 * has verified: a path can never move a visitor off a tenant's own domain onto another tenant's
 * site. The prefix keeps working once a tenant verifies a domain, so links shared before it
 * don't break, and the domain is the canonical address from then on.
 */

const firstSegment = (path: string) => path.split("/")[1] ?? "";

/** First segments the CMS itself answers on, which no tenant's site can be served under. */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([firstSegment(apiPath()), firstSegment(adminPath()), "_next"].filter(Boolean));

/** A short name a tenant's site can be served under: one the CMS doesn't answer on itself. */
export const usableSlug = (slug: string) => TENANT_SLUG.test(slug) && !RESERVED_SEGMENTS.has(slug);

/**
 * Each active tenant's short name and id, held for a few seconds on each server, since every
 * request on the instance's own address reads it. A change made here clears it at once, and
 * other servers catch up within the same few seconds. The same shape as the host cache.
 */
interface SlugCache { bySlug: Map<string, string>; byId: Map<string, string>; loadedAt: number; loading: Promise<SlugCache["bySlug"]> | null }

declare const globalThis: { cmsTenantSlugs?: SlugCache } & typeof global;

const cache: SlugCache = (globalThis.cmsTenantSlugs ??= { bySlug: new Map(), byId: new Map(), loadedAt: 0, loading: null });
const FRESH_MS = 15_000;

export function forgetSlugs() {
  cache.loadedAt = 0;
}

async function loadSlugs(context: ExtensionContext) {
  const bySlug = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const tenant of await listTenants(context)) {
    if (tenant.status !== "active" || !usableSlug(tenant.slug) || bySlug.has(tenant.slug)) continue;
    bySlug.set(tenant.slug, tenant.id);
    byId.set(tenant.id, tenant.slug);
  }
  cache.bySlug = bySlug;
  cache.byId = byId;
  cache.loadedAt = Date.now();
  return bySlug;
}

async function slugs(context: ExtensionContext) {
  if (cache.loadedAt && Date.now() - cache.loadedAt < FRESH_MS) return cache;
  cache.loading ??= loadSlugs(context).finally(() => { cache.loading = null; });
  await cache.loading;
  return cache;
}

/**
 * The tenant whose short name the address's first segment is, or null. Only called once the
 * host has been found to be no tenant's, so this never overrides a verified domain.
 */
export async function tenantForPath(context: ExtensionContext, path: string | null | undefined): Promise<string | null> {
  const slug = firstSegment(path ?? "");
  if (!slug || !usableSlug(slug)) return null;
  return (await slugs(context)).bySlug.get(slug) ?? null;
}

/** The path prefix a tenant's site is served under on the instance's own address, or null. */
export async function basePathOf(context: ExtensionContext, tenant: string): Promise<string | null> {
  const slug = (await slugs(context)).byId.get(tenant);
  return slug ? `/${slug}` : null;
}
