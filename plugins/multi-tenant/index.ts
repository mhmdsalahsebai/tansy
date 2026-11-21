import { z } from "zod";
import { organization } from "better-auth/plugins/organization";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { definePlugin, type AuthAccess, type ExtensionContext } from "tansy/plugin";
import { EVERY_TENANT, MEMBERS_PERMISSION, tenantRoutes } from "./routes";
import { tenantCommands } from "./commands";
import { tenantChecks } from "./doctor";
import { tenantTools } from "./tools";
import { messages } from "./messages";
import { DEFAULT_RECORD, DOMAINS, domainsSchema, originFor, primaryHost, RECORD_NAME, tenantForHost, verifiedHosts } from "./domains";
import { DEFAULT_PURGE_DAYS, expireInvitations, PLANS, plansSchema, recheckDomains, runDuePurges, scopeLimitsOf } from "./lifecycle";
import { basePathOf, tenantForPath } from "./paths";
import { activeTenant, ensureDefaultTenant, findMember, findTenant, listTenants, membershipsOf, PLUGIN, SYSTEM_COLLECTIONS, TENANT_HEADER, TENANT_ID } from "./tenants";

export { DEFAULT_TENANT, TENANT_HEADER } from "./tenants";

export const TENANT_ADMIN = `${PLUGIN}-admin`;
export const TENANT_EDITOR = `${PLUGIN}-editor`;
export const TENANT_STAFF = `${PLUGIN}-staff`;

/** better-auth's organization plugin, as this plugin sets it up. Its own role checks use the CMS's roles. */
function organizations(access?: AuthAccess) {
  const control = access?.accessControl({
    statements: defaultStatements,
    roles: "scoped",
    // A tenant role that manages members can do so in better-auth's terms too. Nothing else.
    grant: (permissions) => (permissions.has(MEMBERS_PERMISSION) ? { member: ["create", "update", "delete"], invitation: ["create", "cancel"] } : {}),
  });
  return organization({
    ...(control ? { ac: control.ac, roles: control.roles } : {}),
    creatorRole: TENANT_ADMIN,
    // Every endpoint is closed to HTTP. Tenants are made by this plugin's routes, after their checks.
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    requireEmailVerificationOnInvitation: true,
    schema: {
      organization: {
        additionalFields: {
          // "suspended" closes the tenant: no request resolves to it. Records stay.
          status: { type: "string", required: false, defaultValue: "active", input: true },
        },
      },
    },
  });
}

/** Every path the organization plugin serves, read from the plugin itself, so an upgrade that adds one closes it too. */
const ORGANIZATION_PATHS = Object.values(organizations().endpoints)
  .map((endpoint) => (endpoint as { path?: unknown }).path)
  .filter((path): path is string => typeof path === "string");

const optionsSchema = z.object({
  siteUrl: z.url({ protocol: /^https?$/ }),
  scopeNewCollections: z.boolean(),
  dnsServers: z.array(z.string().min(1).max(100)).max(5).optional(),
});

export interface MultiTenantOptions {
  /** Where the dashboard is, for links in invitation emails. */
  siteUrl: string;
  /** Whether a collection made under Collections keeps each tenant's records apart unless it says otherwise. Default true. */
  scopeNewCollections?: boolean;
  /** DNS servers that verify tenants' domains, such as ["10.0.0.2"] or ["127.0.0.1:5353"]. The system's own when left out. */
  dnsServers?: string[];
}

/**
 * Many sites, or customers, in one instance: each tenant has its own records in every
 * collection marked scoped, its own members and their roles. Tenants, members and
 * invitations are better-auth's organization plugin. Core keeps every tenant's records apart,
 * below roles and rules (SECURITY_MODEL.md, "Row scopes"), so a request for one tenant never
 * reads or writes another's. See internal/MULTI_TENANT_PLAN.md.
 */
export function multiTenant(options: MultiTenantOptions) {
  const parsed = optionsSchema.parse({ siteUrl: options.siteUrl.replace(/\/+$/, ""), scopeNewCollections: options.scopeNewCollections ?? true, ...(options.dnsServers?.length ? { dnsServers: options.dnsServers } : {}) });
  return definePlugin({
    name: PLUGIN,
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    options: { schema: optionsSchema, value: parsed },
    admin: { server: "@tansy/multi-tenant/admin" },
    messages,
    permissions: { "ext.multi-tenant": ["create", "read", "update", "delete", "members", "domains", "all"] },
    scopedPermissions: [MEMBERS_PERMISSION],
    systemCollections: [...SYSTEM_COLLECTIONS, DOMAINS, PLANS],
    settings: {
      permission: "ext.multi-tenant:update",
      fields: [
        { type: "number", name: "invitationDays", label: "Invitations last", description: "Days before an invitation to a tenant expires.", default: 7, min: 1, max: 60, integer: true },
        { type: "text", name: "verificationRecord", label: "Verification record", description: "The name a tenant's TXT record goes under, before their domain, to prove they control it.", default: DEFAULT_RECORD, maxLength: 63 },
        { type: "number", name: "purgeDays", label: "Days before a purge", description: "How long a suspended tenant waits, once its removal is asked for, before everything it has is deleted. It can be resumed until then.", default: DEFAULT_PURGE_DAYS, min: 1, max: 90, integer: true },
      ],
    },
    auth: {
      plugins: (_settings, _context, access) => [organizations(access)],
      serverOnlyPaths: ORGANIZATION_PATHS,
      // Members sign in on their tenant's own domain, once it's verified.
      trustedOrigins: async (context) => [...(await verifiedHosts(context)).keys()].map((host) => originFor(host, parsed.siteUrl)),
    },
    scope: {
      label: "Tenant",
      everyValue: EVERY_TENANT,
      scopeNewCollections: parsed.scopeNewCollections,
      resolve: async ({ host, headers, path, principal }, context) => {
        // A verified domain decides for everyone: a tenant's site is that tenant's, whoever asks.
        const byHost = await tenantForHost(context, host);
        if (byHost) return byHost;
        // No tenant has verified this host, so it is the instance's own address, where a first
        // segment naming a tenant serves that tenant's site: /acme/blog/hello. Read below the
        // host, and never on a tenant's domain, so a path can't move a visitor between tenants.
        // The CMS's own addresses are left out, so a tenant can't be reached under /api or /dashboard.
        const byPath = await tenantForPath(context, path);
        if (byPath) return byPath;
        // Visitors get a tenant from its domain or its prefix only. A header is never enough for them.
        if (principal.kind === "anonymous") return null;
        const named = headers.get(TENANT_HEADER)?.trim();
        if (named) return named;
        if (principal.kind !== "user") return null;
        // The session's choice may be stale, as when they've left the tenant since: then it's ignored, not refused.
        const active = await activeTenant(context, principal.session.id);
        if (active && (principal.permissions.has(EVERY_TENANT) || (await findMember(context, active, principal.user.id)))) return active;
        // With no choice that applies, a member works in the first tenant they joined. Staff who reach every tenant work in none until they choose.
        if (principal.permissions.has(EVERY_TENANT)) return null;
        const [first] = (await membershipsOf(context, principal.user.id)).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        return first?.tenant ?? null;
      },
      exists: async (value, context) => (await findTenant(context, value))?.status === "active",
      rolesFor: async (principal, value, context) => (await findMember(context, value, principal.user.id))?.roles ?? [],
      initial: (context: ExtensionContext) => ensureDefaultTenant(context),
      values: async (context) => (await listTenants(context)).filter((tenant) => tenant.status === "active").map((tenant) => tenant.id),
      // Without a domain of its own, a tenant's site is served under its short name on the instance's address.
      basePath: (value, context) => basePathOf(context, value),
      // Links in a tenant's emails and feeds go to its own domain, once it has a verified one.
      siteUrl: async (value, context) => {
        const host = await primaryHost(context, value);
        return host ? originFor(host, parsed.siteUrl) : null;
      },
      // A tenant's plan: core enforces records, bytes of files and requests a minute.
      limits: (value, context) => scopeLimitsOf(context, value),
    },
    migrations: [{
      id: "001-roles",
      up: async ({ roles }) => {
        await roles.ensure({
          name: TENANT_ADMIN,
          label: "Tenant admin",
          description: "Runs one tenant: its records, redirects, site name and look, and its members.",
          scope: "scoped",
          permissions: ["dashboard:access", "collection:read", "file:create", "record:list", "record:read", "record:create", "record:update", "record:delete", "record:publish", "redirect:read", "redirect:manage", "setting:site", MEMBERS_PERMISSION],
        });
        await roles.ensure({
          name: TENANT_EDITOR,
          label: "Tenant editor",
          description: "Writes one tenant's records.",
          scope: "scoped",
          permissions: ["dashboard:access", "collection:read", "file:create", "record:list", "record:read", "record:create", "record:update"],
        });
        await roles.ensure({
          name: TENANT_STAFF,
          label: "Tenant staff",
          description: "Sees every tenant and works in any of them with their other roles. Each switch is audited.",
          permissions: ["dashboard:access", EVERY_TENANT, "ext.multi-tenant:read"],
        });
      },
    }, {
      id: "002-domains",
      up: async ({ schema }) => {
        if (await schema.describe(DOMAINS)) throw new Error(`A collection called "${DOMAINS}" already exists, and the multi-tenant plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
        await schema.apply(domainsSchema());
      },
    }, {
      id: "003-lifecycle",
      up: async ({ schema }) => {
        if (await schema.describe(PLANS)) throw new Error(`A collection called "${PLANS}" already exists, and the multi-tenant plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
        await schema.apply(plansSchema());
        // When a verified domain's proof went missing, so it stops routing only after a grace period.
        await schema.addFields(DOMAINS, [{ name: "failingSince", type: "datetime", config: {} }]);
      },
    }],
    jobs: [
      { name: "multi-tenant.purge", cron: "11 * * * *", handler: (context) => runDuePurges(context) },
      { name: "multi-tenant.invitations", cron: "29 * * * *", handler: (context) => expireInvitations(context) },
      {
        name: "multi-tenant.domains",
        cron: "47 4 * * *",
        handler: async (context) => {
          const value = (await context.settings.get()).verificationRecord;
          await recheckDomains(context, typeof value === "string" && RECORD_NAME.test(value) ? value : DEFAULT_RECORD, parsed.dnsServers);
        },
      },
    ],
    doctor: () => tenantChecks(parsed),
    routes: tenantRoutes(parsed),
    tools: tenantTools(),
    commands: tenantCommands(),
  });
}

export { TENANT_ID };
