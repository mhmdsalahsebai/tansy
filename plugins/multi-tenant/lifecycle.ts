import type { ExtensionContext, RecordValues, ScopeLimits } from "tansy/plugin";
import { DOMAINS, dnsHasProof, forgetHosts, type Domain } from "./domains";
import { forgetSlugs } from "./paths";
import { findTenant, INVITATIONS, listTenants, MEMBERS, ORGANIZATIONS, PLUGIN, SESSIONS, TENANT_ID, type Tenant } from "./tenants";

/**
 * A tenant's life after it's made (Phase 24): its limits, closing it (suspend) and opening it
 * again, and removing it for good, which waits some days after it's asked for. Kept in a
 * system-owned collection beside the organization, one record per tenant, since better-auth's
 * organization has no place for them.
 */

export const PLANS = `${PLUGIN}-plans`;

/** Days between asking for a purge and it happening, unless the settings say otherwise. */
export const DEFAULT_PURGE_DAYS = 7;
/** A verified domain whose proof is gone this long stops routing. Short DNS outages don't. */
const DOMAIN_GRACE_MS = 3 * 86_400_000;

export interface TenantLimits {
  records: number | null;
  storageBytes: number | null;
  members: number | null;
  requestsPerMinute: number | null;
}

export interface Plan extends TenantLimits {
  id: number | null;
  tenant: string;
  /** When the purge happens. Null when none was asked for. */
  purgeAt: string | null;
  purgeRequestedBy: string | null;
}

export const NO_LIMITS: TenantLimits = { records: null, storageBytes: null, members: null, requestsPerMinute: null };

export const plansSchema = () => ({
  version: 1,
  collections: [{
    slug: PLANS,
    name: "Tenant plans",
    description: "Each tenant's limits, and when a tenant asked to be removed will be. Only the multi-tenant plugin writes these.",
    urlPattern: null,
    rules: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null },
    fields: [
      { name: "organizationId", type: "text", config: { required: true, maxLength: 64, unique: true } },
      { name: "records", type: "number", config: { format: "integer", min: 0 } },
      { name: "storageBytes", type: "number", config: { format: "integer", min: 0 } },
      { name: "members", type: "number", config: { format: "integer", min: 0 } },
      { name: "requestsPerMinute", type: "number", config: { format: "integer", min: 0 } },
      { name: "purgeAt", type: "datetime", config: {} },
      { name: "purgeRequestedBy", type: "text", config: { maxLength: 64 } },
    ],
  }],
});

const str = (value: unknown) => (typeof value === "string" ? value : "");
const limit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

const quotedTenant = (tenant: string) => {
  if (!TENANT_ID.test(tenant)) throw new Error(`Not a tenant id: ${JSON.stringify(tenant).slice(0, 80)}`);
  return `"${tenant}"`;
};

const toPlan = (tenant: string, row: RecordValues | null): Plan => ({
  id: row ? Number(row.id) : null,
  tenant,
  records: limit(row?.records),
  storageBytes: limit(row?.storageBytes),
  members: limit(row?.members),
  requestsPerMinute: limit(row?.requestsPerMinute),
  purgeAt: str(row?.purgeAt) || null,
  purgeRequestedBy: str(row?.purgeRequestedBy) || null,
});

type Records = ExtensionContext["system"]["records"];

/** Routes can trust the new set of origins at once. Jobs can't, and leave it to core's next read, within half a minute. */
const refreshOrigins = (context: ExtensionContext) => (context as ExtensionContext & { auth?: { refreshTrustedOrigins(): Promise<void> } }).auth?.refreshTrustedOrigins();

async function all(records: Records, filter: string): Promise<RecordValues[]> {
  const items: RecordValues[] = [];
  for (let page = 1; ; page += 1) {
    const result = await records.list(PLANS, { filter, perPage: 200, page, sort: "id" });
    items.push(...result.items);
    if (page >= result.totalPages) return items;
  }
}

/** A tenant's plan. One that was never set has no limits and no purge. */
export async function planOf(context: ExtensionContext, tenant: string): Promise<Plan> {
  const [row] = await all(context.system.records, `organizationId = ${quotedTenant(tenant)}`);
  return toPlan(tenant, row ?? null);
}

async function savePlan(context: ExtensionContext, tenant: string, patch: Partial<Omit<Plan, "id" | "tenant">>): Promise<Plan> {
  const current = await planOf(context, tenant);
  if (current.id === null) await context.system.records.create(PLANS, { status: "published", organizationId: tenant, ...patch });
  else await context.system.records.update(PLANS, current.id, patch);
  await context.scope.forgetLimits(tenant);
  return { ...current, ...patch };
}

export const setLimits = (context: ExtensionContext, tenant: string, limits: TenantLimits) => savePlan(context, tenant, limits);

/** What core enforces (records, bytes, requests). Members are counted by this plugin's own routes. */
export async function scopeLimitsOf(context: ExtensionContext, tenant: string): Promise<ScopeLimits | null> {
  const plan = await planOf(context, tenant);
  return { records: plan.records, storageBytes: plan.storageBytes, requestsPerMinute: plan.requestsPerMinute };
}

async function setStatus(context: ExtensionContext, tenant: Tenant & { recordId: number }, status: "active" | "suspended") {
  await context.system.records.update(ORGANIZATIONS, tenant.recordId, { organizationStatus: status });
  // Its domains, and its path prefix, stop (or start) routing to it at once on this server.
  forgetHosts();
  forgetSlugs();
}

/** Closes a tenant: nothing resolves to it, so no reads, no writes and no sign-in to it. Its data stays. */
export const suspendTenant = (context: ExtensionContext, tenant: Tenant & { recordId: number }) => setStatus(context, tenant, "suspended");

/** Opens a suspended tenant again, and calls off a purge it was waiting for. */
export async function resumeTenant(context: ExtensionContext, tenant: Tenant & { recordId: number }) {
  await setStatus(context, tenant, "active");
  const plan = await planOf(context, tenant.id);
  if (plan.purgeAt) await savePlan(context, tenant.id, { purgeAt: null, purgeRequestedBy: null });
}

/** Asks for a suspended tenant to be removed for good after `days`. */
export async function schedulePurge(context: ExtensionContext, tenant: string, days: number, by: string) {
  const purgeAt = new Date(Date.now() + days * 86_400_000).toISOString();
  await savePlan(context, tenant, { purgeAt, purgeRequestedBy: by });
  return purgeAt;
}

export const cancelPurge = (context: ExtensionContext, tenant: string) => savePlan(context, tenant, { purgeAt: null, purgeRequestedBy: null });

async function deleteWhere(context: ExtensionContext, slug: string, filter: string) {
  for (;;) {
    const { items } = await context.system.records.list(slug, { filter, perPage: 200, page: 1, sort: "id" });
    if (!items.length) return;
    for (const item of items) await context.system.records.delete(slug, Number(item.id));
  }
}

/**
 * Removes a tenant and everything it had: core removes its rows and files, then this plugin
 * its members, invitations, domains, plan and the organization itself. Sessions that had it
 * as their choice forget it.
 */
export async function purgeTenant(context: ExtensionContext, tenant: string) {
  const removed = await context.scope.data.purge(tenant);
  const quoted = quotedTenant(tenant);
  await deleteWhere(context, MEMBERS, `organizationId = ${quoted}`);
  await deleteWhere(context, INVITATIONS, `organizationId = ${quoted}`);
  await deleteWhere(context, DOMAINS, `organizationId = ${quoted}`);
  for (;;) {
    const { items } = await context.system.records.list(SESSIONS, { filter: `activeOrganizationId = ${quoted}`, perPage: 200, page: 1, sort: "id" });
    if (!items.length) break;
    for (const item of items) await context.system.records.update(SESSIONS, Number(item.id), { activeOrganizationId: null });
  }
  await deleteWhere(context, PLANS, `organizationId = ${quoted}`);
  await deleteWhere(context, ORGANIZATIONS, `authId = ${quoted}`);
  forgetHosts();
  forgetSlugs();
  await refreshOrigins(context);
  await context.scope.forgetLimits(tenant);
  return removed;
}

/** The job: purges every suspended tenant whose waiting period is over. A tenant resumed meanwhile has no date any more. */
export async function runDuePurges(context: ExtensionContext, now = new Date()) {
  const due = (await all(context.system.records, "purgeAt != null")).map((row) => toPlan(str(row.organizationId), row)).filter((plan) => plan.purgeAt && Date.parse(plan.purgeAt) <= now.getTime());
  for (const plan of due) {
    const tenant = await findTenant(context, plan.tenant);
    // Only ever a suspended one: a purge asked of an open tenant is a mistake, kept until someone looks.
    if (tenant && tenant.status !== "suspended") continue;
    try {
      const removed = await purgeTenant(context, plan.tenant);
      console.info(`[multi-tenant] purged ${plan.tenant}: ${removed.records} records and ${removed.files} files`);
    } catch (error) {
      console.error(`[multi-tenant] purging ${plan.tenant} failed, and will be tried again`, error);
    }
  }
}

/**
 * The job: checks each verified domain's proof is still in DNS. One whose proof has been gone
 * for three days stops routing, so a domain that changed hands can't keep serving a tenant.
 */
export async function recheckDomains(context: ExtensionContext, record: string, servers: string[] | undefined, now = new Date(), hasProof = dnsHasProof) {
  let changed = false;
  for (let page = 1; ; page += 1) {
    const result = await context.system.records.list(DOMAINS, { filter: "verifiedAt != null", perPage: 200, page, sort: "id" });
    for (const row of result.items) {
      const domain = { id: Number(row.id), host: str(row.host), token: str(row.token), primary: row.primary === true } as Domain;
      const stamp = now.toISOString();
      if (await hasProof(domain, record, servers)) {
        await context.system.records.update(DOMAINS, domain.id, { checkedAt: stamp, failingSince: null });
        continue;
      }
      const since = str(row.failingSince);
      if (!since) {
        await context.system.records.update(DOMAINS, domain.id, { checkedAt: stamp, failingSince: stamp });
      } else if (now.getTime() - Date.parse(since) >= DOMAIN_GRACE_MS) {
        await context.system.records.update(DOMAINS, domain.id, { checkedAt: stamp, verifiedAt: null, primary: false, failingSince: null });
        changed = true;
        console.warn(`[multi-tenant] ${domain.host} lost its verification: its TXT record has been missing since ${since}.`);
      } else {
        await context.system.records.update(DOMAINS, domain.id, { checkedAt: stamp });
      }
    }
    if (page >= result.totalPages) break;
  }
  if (changed) {
    forgetHosts();
    await refreshOrigins(context);
  }
}

/** The job: invitations past their date are marked expired, so lists and limits stop counting them. */
export async function expireInvitations(context: ExtensionContext, now = new Date()) {
  const expired: number[] = [];
  for (let page = 1; ; page += 1) {
    const result = await context.system.records.list(INVITATIONS, { filter: `invitationStatus = "pending"`, perPage: 200, page, sort: "id" });
    for (const item of result.items) if (Date.parse(str(item.expiresAt)) <= now.getTime()) expired.push(Number(item.id));
    if (page >= result.totalPages) break;
  }
  for (const id of expired) await context.system.records.update(INVITATIONS, id, { invitationStatus: "expired" });
}

/** Every tenant's status, for the dashboard's danger zone and limits. */
export async function plansFor(context: ExtensionContext, tenants?: Tenant[]) {
  const list = tenants ?? await listTenants(context);
  return Promise.all(list.map(async (tenant) => ({ tenant, plan: await planOf(context, tenant.id) })));
}
