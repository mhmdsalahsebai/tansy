import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { ExtensionContext, RecordValues } from "tansy/plugin";
import { PLUGIN, TENANT_ID } from "./tenants";

/**
 * A tenant's domains: the hosts its site answers on. A domain routes, and its origin is
 * trusted for signing in, only once DNS shows the tenant controls it: a TXT record at
 * `<record>.<host>` holding the token this plugin gave. Kept in a system-owned collection
 * that isn't scoped, since a request's host is read before its tenant is known.
 */

export const DOMAINS = `${PLUGIN}-domains`;
export const DEFAULT_RECORD = "_cms-verification";

/** Lower-case host names with at least one dot, such as client.example or www.client.example. */
export const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** The name the TXT record goes under, before the host. */
export const RECORD_NAME = /^_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface Domain {
  id: number;
  tenant: string;
  host: string;
  primary: boolean;
  token: string;
  verifiedAt: string | null;
  checkedAt: string | null;
  createdAt: string | null;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export const domainsSchema = () => ({
  version: 1,
  collections: [{
    slug: DOMAINS,
    name: "Tenant domains",
    description: "The hosts each tenant's site answers on. Only the multi-tenant plugin writes these.",
    urlPattern: null,
    rules: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null },
    fields: [
      { name: "host", type: "text", config: { required: true, maxLength: 253 } },
      { name: "organizationId", type: "text", config: { required: true, maxLength: 64 } },
      { name: "primary", type: "boolean", config: {} },
      { name: "token", type: "text", config: { maxLength: 64, hidden: true } },
      { name: "verifiedAt", type: "datetime", config: {} },
      { name: "checkedAt", type: "datetime", config: {} },
    ],
  }],
});

const toDomain = (row: RecordValues): Domain => ({
  id: Number(row.id),
  tenant: str(row.organizationId),
  host: str(row.host),
  primary: row.primary === true,
  token: str(row.token),
  verifiedAt: str(row.verifiedAt) || null,
  checkedAt: str(row.checkedAt) || null,
  createdAt: str(row.createdAt) || null,
});

type Records = ExtensionContext["system"]["records"];

async function all(records: Records, filter: string): Promise<Domain[]> {
  const items: Domain[] = [];
  for (let page = 1; ; page += 1) {
    const result = await records.list(DOMAINS, { filter, perPage: 200, page, sort: "id" });
    items.push(...result.items.map(toDomain));
    if (page >= result.totalPages) return items;
  }
}

const quotedHost = (host: string) => {
  if (!HOST.test(host)) throw new Error(`Not a host: ${JSON.stringify(host).slice(0, 80)}`);
  return `"${host}"`;
};
const quotedTenant = (tenant: string) => {
  if (!TENANT_ID.test(tenant)) throw new Error(`Not a tenant id: ${JSON.stringify(tenant).slice(0, 80)}`);
  return `"${tenant}"`;
};

export const domainsOf = (context: ExtensionContext, tenant: string) => all(context.system.records, `organizationId = ${quotedTenant(tenant)}`);

export async function findDomain(context: ExtensionContext, tenant: string, id: number): Promise<Domain | null> {
  return (await domainsOf(context, tenant)).find((domain) => domain.id === id) ?? null;
}

/** Every claim on a host, by any tenant. At most one is verified. */
export const claimsOn = (context: ExtensionContext, host: string) => all(context.system.records, `host = ${quotedHost(host)}`);

export const newToken = () => randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 24);

/** A host a person typed, as stored: lower-case, no scheme, path, port or trailing dot. Null when it isn't one a tenant can have. */
export function normalizeHost(value: string, reserved: ReadonlySet<string>): string | null {
  let host = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\.$/, "");
  if (!HOST.test(host) || isIP(host) || host.endsWith(".localhost") || reserved.has(host)) return null;
  return host;
}

/**
 * Which tenant each verified host belongs to, held for a few seconds on each server, since
 * every request reads it. A change made here clears it at once. Other servers catch up
 * within the same few seconds.
 */
interface HostCache { map: Map<string, string>; loadedAt: number; loading: Promise<Map<string, string>> | null }

declare const globalThis: { cmsTenantHosts?: HostCache } & typeof global;

const cache: HostCache = (globalThis.cmsTenantHosts ??= { map: new Map(), loadedAt: 0, loading: null });
const FRESH_MS = 15_000;

export function forgetHosts() {
  cache.loadedAt = 0;
}

async function loadHosts(context: ExtensionContext): Promise<Map<string, string>> {
  const verified = (await all(context.system.records, "verifiedAt != null")).sort((a, b) => (a.verifiedAt ?? "").localeCompare(b.verifiedAt ?? ""));
  const map = new Map<string, string>();
  // The first to verify keeps a host. A later claim can't verify while it stands, so this only settles a race.
  for (const domain of verified) if (!map.has(domain.host)) map.set(domain.host, domain.tenant);
  return map;
}

export async function verifiedHosts(context: ExtensionContext): Promise<Map<string, string>> {
  if (cache.loadedAt && Date.now() - cache.loadedAt < FRESH_MS) return cache.map;
  cache.loading ??= loadHosts(context).then((map) => {
    cache.map = map;
    cache.loadedAt = Date.now();
    return map;
  }).finally(() => { cache.loading = null; });
  return cache.loading;
}

/** The tenant whose verified domain this host is, or null. */
export async function tenantForHost(context: ExtensionContext, host: string | null): Promise<string | null> {
  if (!host || !HOST.test(host)) return null;
  return (await verifiedHosts(context)).get(host) ?? null;
}

/** A tenant's main verified domain: the one marked primary, or else the first verified. Null with none. */
export async function primaryHost(context: ExtensionContext, tenant: string): Promise<string | null> {
  const verified = (await domainsOf(context, tenant)).filter((domain) => domain.verifiedAt).sort((a, b) => Number(b.primary) - Number(a.primary) || (a.verifiedAt ?? "").localeCompare(b.verifiedAt ?? ""));
  return verified[0]?.host ?? null;
}

/** What a tenant's site is served from, for trusted origins: the dashboard's own scheme and port, on the tenant's host. */
export function originFor(host: string, siteUrl: string): string {
  const site = new URL(siteUrl);
  return `${site.protocol}//${host}${site.port ? `:${site.port}` : ""}`;
}

/** The TXT value that proves a tenant controls a host. */
export const proof = (token: string) => `cms-verification=${token}`;

/**
 * Whether DNS holds the proof for this domain. A lookup that fails is a no, so a resolver
 * that's down never verifies anything. `servers` replaces the system's resolvers, such as
 * for a private network or tests.
 */
export async function dnsHasProof(domain: Pick<Domain, "host" | "token">, record: string, servers?: string[]): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  if (servers?.length) resolver.setServers(servers);
  try {
    const answers = await resolver.resolveTxt(`${record}.${domain.host}`);
    return answers.some((chunks) => chunks.join("") === proof(domain.token));
  } catch {
    return false;
  }
}
