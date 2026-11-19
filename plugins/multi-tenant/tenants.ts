import { randomBytes } from "node:crypto";
import { HttpError, type ExtensionContext, type ExtensionRouteContext, type RecordValues } from "tansy/plugin";

/**
 * The tenants' data, kept by better-auth's organization plugin in this plugin's collections:
 * one collection per model, named with the plugin's prefix, and system-owned, so only this
 * plugin writes them. Fields keep better-auth's names, except those records reserve, which
 * get the model's name in front (an organization's `status` is `organizationStatus`).
 */

export const PLUGIN = "multi-tenant";
export const ORGANIZATIONS = `${PLUGIN}-organization`;
export const MEMBERS = `${PLUGIN}-member`;
export const INVITATIONS = `${PLUGIN}-invitation`;
export const SESSIONS = `${PLUGIN}-session-data`;
export const SYSTEM_COLLECTIONS = [ORGANIZATIONS, MEMBERS, INVITATIONS, SESSIONS];

/** The tenant that existing records go to when a collection first becomes scoped. */
export const DEFAULT_TENANT = "default";

/** Tenant ids are row scope values, and better-auth's ids fit them too. Checked wherever one enters, so it can go in a filter. */
export const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Member and invitation ids, which this plugin and better-auth make. */
export const RECORD_KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whoever a piece of work is for. The same shape on a route, an agent tool and a dashboard page. */
export type TenantPrincipal = ExtensionRouteContext["principal"];
/** Enough context for the helpers below: what every plugin surface has, plus a caller. */
export type CallerContext = ExtensionContext & { principal: TenantPrincipal };

/** Names the tenant a signed-in request is for, ahead of the one the session last switched to. */
export const TENANT_HEADER = "x-cms-tenant";

/** Staff who reach every tenant. */
export const EVERY_TENANT = "ext.multi-tenant:all";
/** Managing members within one tenant, which a tenant role may hold. */
export const MEMBERS_PERMISSION = "ext.multi-tenant:members";

export const userOf = (principal: TenantPrincipal) => {
  if (principal.kind === "anonymous") throw new HttpError(401, "UNAUTHENTICATED", "Authentication required.");
  return principal.user;
};

export type TenantStatus = "active" | "suspended";

export interface Tenant { id: string; name: string; slug: string; status: TenantStatus; createdAt: string | null }
export interface Member { id: string; recordId: number; tenant: string; userId: string; roles: string[]; createdAt: string | null }
export interface Invitation { id: string; recordId: number; tenant: string; email: string; roles: string[]; status: string; expiresAt: string | null; inviterId: string | null }

const str = (value: unknown) => (typeof value === "string" ? value : "");
/** better-auth keeps several roles as one comma-separated value. */
export const roleList = (value: unknown) => str(value).split(",").map((name) => name.trim()).filter(Boolean);
export const newId = () => randomBytes(24).toString("base64url").replace(/[-_]/g, "").slice(0, 32);

const quoted = (value: string) => {
  if (!RECORD_KEY.test(value)) throw new Error(`Not an id: ${JSON.stringify(value).slice(0, 80)}`);
  return `"${value}"`;
};

type Records = ExtensionContext["system"]["records"];

async function all(records: Records, slug: string, filter: string): Promise<RecordValues[]> {
  const items: RecordValues[] = [];
  for (let page = 1; ; page += 1) {
    const result = await records.list(slug, { filter, perPage: 200, page, sort: "id" });
    items.push(...result.items);
    if (page >= result.totalPages) return items;
  }
}

const toTenant = (row: RecordValues): Tenant => ({
  id: str(row.authId),
  name: str(row.name),
  slug: str(row.slug),
  status: row.organizationStatus === "suspended" ? "suspended" : "active",
  createdAt: str(row.organizationCreatedAt) || null,
});

const toMember = (row: RecordValues): Member => ({
  id: str(row.authId),
  recordId: Number(row.id),
  tenant: str(row.organizationId),
  userId: str(row.userId),
  roles: roleList(row.role),
  createdAt: str(row.memberCreatedAt) || null,
});

const toInvitation = (row: RecordValues): Invitation => ({
  id: str(row.authId),
  recordId: Number(row.id),
  tenant: str(row.organizationId),
  email: str(row.email),
  roles: roleList(row.role),
  status: str(row.invitationStatus),
  expiresAt: str(row.expiresAt) || null,
  inviterId: str(row.inviterId) || null,
});

/** A tenant as any caller may see it: never better-auth's own row. */
export const publicTenant = ({ id, name, slug, status, createdAt }: Tenant) => ({ id, name, slug, status, createdAt });

/** Tenants someone can work in: every one with the permission to read them all, else those they belong to. */
export async function reachable(context: CallerContext, userId: string) {
  const { permissions } = context.principal;
  const memberships = await membershipsOf(context, userId);
  const everyTenant = permissions.has(EVERY_TENANT) || permissions.has("ext.multi-tenant:read");
  const tenants = everyTenant ? await listTenants(context) : await listTenants(context, memberships.map((member) => member.tenant));
  return { tenants, memberships };
}

/** A tenant by id, for staff surfaces that act on any of them, suspended ones included. */
export async function requireTenant(context: ExtensionContext, id: string) {
  const tenant = TENANT_ID.test(id) ? await findTenant(context, id) : null;
  if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return tenant;
}

export async function findTenant(context: ExtensionContext, id: string): Promise<(Tenant & { recordId: number }) | null> {
  if (!TENANT_ID.test(id)) return null;
  const [row] = await all(context.system.records, ORGANIZATIONS, `authId = ${quoted(id)}`);
  return row ? { ...toTenant(row), recordId: Number(row.id) } : null;
}

export async function listTenants(context: ExtensionContext, ids?: string[]): Promise<Tenant[]> {
  if (ids && !ids.length) return [];
  const filter = ids ? ids.filter((id) => TENANT_ID.test(id)).map((id) => `authId = ${quoted(id)}`).join(" || ") : "";
  return (await all(context.system.records, ORGANIZATIONS, filter)).map(toTenant);
}

export async function membersOf(context: ExtensionContext, tenant: string): Promise<Member[]> {
  return (await all(context.system.records, MEMBERS, `organizationId = ${quoted(tenant)}`)).map(toMember);
}

export async function membershipsOf(context: ExtensionContext, userId: string): Promise<Member[]> {
  return (await all(context.system.records, MEMBERS, `userId = ${quoted(userId)}`)).map(toMember);
}

export async function findMember(context: ExtensionContext, tenant: string, userId: string): Promise<Member | null> {
  if (!TENANT_ID.test(tenant) || !RECORD_KEY.test(userId)) return null;
  const [row] = await all(context.system.records, MEMBERS, `organizationId = ${quoted(tenant)} && userId = ${quoted(userId)}`);
  return row ? toMember(row) : null;
}

export async function findMemberById(context: ExtensionContext, tenant: string, id: string): Promise<Member | null> {
  if (!RECORD_KEY.test(id)) return null;
  const [row] = await all(context.system.records, MEMBERS, `organizationId = ${quoted(tenant)} && authId = ${quoted(id)}`);
  return row ? toMember(row) : null;
}

export async function invitationsOf(context: ExtensionContext, tenant: string): Promise<Invitation[]> {
  return (await all(context.system.records, INVITATIONS, `organizationId = ${quoted(tenant)} && invitationStatus = "pending"`)).map(toInvitation);
}

/** An invitation by its id alone, whichever tenant it's for. */
export async function invitationById(context: ExtensionContext, id: string): Promise<Invitation | null> {
  if (!RECORD_KEY.test(id)) return null;
  const [row] = await all(context.system.records, INVITATIONS, `authId = ${quoted(id)}`);
  return row ? toInvitation(row) : null;
}

export async function findInvitation(context: ExtensionContext, tenant: string, id: string): Promise<Invitation | null> {
  if (!RECORD_KEY.test(id)) return null;
  const [row] = await all(context.system.records, INVITATIONS, `organizationId = ${quoted(tenant)} && authId = ${quoted(id)}`);
  return row ? toInvitation(row) : null;
}

/** The tenant a session last switched to, kept on the session as better-auth's `activeOrganizationId`. */
export async function activeTenant(context: ExtensionContext, sessionId: string): Promise<string | null> {
  if (!RECORD_KEY.test(sessionId)) return null;
  const [row] = await all(context.system.records, SESSIONS, `coreId = ${quoted(sessionId)}`);
  const value = str(row?.activeOrganizationId);
  return TENANT_ID.test(value) ? value : null;
}

export async function setActiveTenant(context: ExtensionContext, sessionId: string, tenant: string | null) {
  if (!RECORD_KEY.test(sessionId)) throw new Error("Not a session id.");
  const records = context.system.records;
  const [row] = await all(records, SESSIONS, `coreId = ${quoted(sessionId)}`);
  if (row) await records.update(SESSIONS, Number(row.id), { activeOrganizationId: tenant });
  else await records.create(SESSIONS, { status: "published", coreId: sessionId, activeOrganizationId: tenant });
}

/** The first tenant, made when the plugin is first needed, so a site that was one tenant keeps its records in it. */
export async function ensureDefaultTenant(context: ExtensionContext): Promise<string> {
  if (await findTenant(context, DEFAULT_TENANT)) return DEFAULT_TENANT;
  try {
    await context.system.records.create(ORGANIZATIONS, {
      status: "published",
      authId: DEFAULT_TENANT,
      name: "Default",
      slug: DEFAULT_TENANT,
      organizationStatus: "active",
      organizationCreatedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Another server may have made it first.
    if (!(await findTenant(context, DEFAULT_TENANT))) throw error;
  }
  return DEFAULT_TENANT;
}
