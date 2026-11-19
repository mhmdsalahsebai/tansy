import { z } from "zod";
import { defineTool, HttpError, type AgentTool, type AgentToolContext } from "tansy/plugin";
import { domainsOf } from "./domains";
import { planOf, resumeTenant, suspendTenant } from "./lifecycle";
import {
  MEMBERS_PERMISSION, membersOf, publicTenant, reachable, requireTenant, TENANT_ID, userOf,
} from "./tenants";

/**
 * Tenants for an agent: served over MCP at /api/mcp, and through `context.tools` for an
 * in-dashboard assistant. Each one runs as the caller and states the permission it needs.
 *
 * **A tool does only what an API key may do on one of this plugin's routes**, with the same
 * permission. A tool call shows no recent sign-in, so anything a route guards with `fresh` —
 * making a tenant, changing its limits, asking for a purge — stays on that route, where a person
 * signs in again first. Nor is a tool a place for the export and import, which carry everything a
 * tenant has as a stream. `tests/unit/multi-tenant-tools.test.ts` holds the line, and
 * MULTI_TENANT_PLAN.md says why.
 */

const tenantId = z.string().regex(TENANT_ID).describe("The tenant's id, as multi_tenant_list_tenants gives it.");

/** Both lists are of the tenant being worked in, which is the caller's own: no input names a tenant. */
async function currentTenant(context: AgentToolContext) {
  const current = context.principal.scope;
  if (!current) throw new HttpError(400, "SCOPE_REQUIRED", "Choose a tenant first, or work in one.");
  return requireTenant(context, current);
}

export function tenantTools(): AgentTool[] {
  return [
    defineTool({
      name: "multi_tenant_list_tenants",
      description: "List the tenants you can work in, each with its id, name, short name, status and the roles you hold there. Staff who can read every tenant get them all. Call this first: the other tools take an id from it.",
      input: z.object({}),
      access: { access: "authenticated" },
      write: false,
      handler: async (context) => {
        const { tenants, memberships } = await reachable(context, userOf(context.principal).id);
        const roles = new Map(memberships.map((member) => [member.tenant, member.roles]));
        return {
          current: context.principal.scope ?? null,
          items: tenants.map((tenant) => ({ ...publicTenant(tenant), roles: roles.get(tenant.id) ?? [] })),
        };
      },
    }),

    defineTool({
      name: "multi_tenant_describe_tenant",
      description: "One tenant's plan: its status, its limits on records, file bytes, members and requests a minute, what it is using against them, and when any purge it is waiting for happens. Limits are changed by a person in the dashboard, not here.",
      input: z.object({ tenant: tenantId }),
      access: { access: "permission", permission: "ext.multi-tenant:read" },
      write: false,
      handler: async (context) => {
        const tenant = await requireTenant(context, context.input.tenant);
        const [plan, usage, members] = await Promise.all([
          planOf(context, tenant.id),
          context.scope.data.usage(tenant.id),
          membersOf(context, tenant.id),
        ]);
        // Domains are the domains permission's, so they are a tool of their own, not part of this.
        return {
          ...publicTenant(tenant),
          limits: { records: plan.records, storageBytes: plan.storageBytes, members: plan.members, requestsPerMinute: plan.requestsPerMinute },
          usage: { ...usage, members: members.length },
          purgeAt: plan.purgeAt,
        };
      },
    }),

    defineTool({
      name: "multi_tenant_list_domains",
      description: "The domains claimed for the tenant you are working in, each with whether DNS has proved it and whether it is the tenant's main one. A claim routes nothing until it is verified.",
      input: z.object({}),
      access: { access: "permission", permission: "ext.multi-tenant:domains" },
      write: false,
      handler: async (context) => {
        const tenant = await currentTenant(context);
        const domains = await domainsOf(context, tenant.id);
        return {
          tenant: publicTenant(tenant),
          // Never the token: it is the proof, and it is a hidden field on the record for that reason.
          items: domains.map((domain) => ({
            id: domain.id,
            host: domain.host,
            verified: domain.verifiedAt !== null,
            primary: domain.primary,
            verifiedAt: domain.verifiedAt,
          })),
        };
      },
    }),

    defineTool({
      name: "multi_tenant_list_members",
      description: "The members of the tenant you are working in, with their names, email addresses and the roles they hold there. It is always your own tenant: there is no way to ask for another's.",
      input: z.object({}),
      access: { access: "permission", permission: MEMBERS_PERMISSION },
      write: false,
      handler: async (context) => {
        const tenant = await currentTenant(context);
        const members = await membersOf(context, tenant.id);
        const people = await Promise.all(members.map((member) => context.system.users.get(member.userId)));
        return {
          tenant: publicTenant(tenant),
          items: members.map((member, index) => ({
            id: member.id,
            name: people[index]?.name ?? null,
            email: people[index]?.email ?? null,
            roles: member.roles,
            createdAt: member.createdAt,
          })),
        };
      },
    }),

    defineTool({
      name: "multi_tenant_suspend_tenant",
      description: "Suspend a tenant. It then resolves for nobody: its domains, members and API keys reach nothing, and everything it has stays where it is. Resume it to undo this. Removing a tenant for good is not something you can do: a person asks for that in the dashboard.",
      input: z.object({ tenant: tenantId }),
      access: { access: "permission", permission: "ext.multi-tenant:delete" },
      write: true,
      audit: "multi_tenant.suspend",
      handler: async (context) => {
        const tenant = await requireTenant(context, context.input.tenant);
        if (tenant.status !== "suspended") await suspendTenant(context, tenant);
        context.auditTarget("tenant", tenant.id);
        return { ...publicTenant(tenant), status: "suspended" as const };
      },
    }),

    defineTool({
      name: "multi_tenant_resume_tenant",
      description: "Let a suspended tenant work again, and call off any purge it was waiting for.",
      input: z.object({ tenant: tenantId }),
      access: { access: "permission", permission: "ext.multi-tenant:delete" },
      write: true,
      audit: "multi_tenant.resume",
      handler: async (context) => {
        const tenant = await requireTenant(context, context.input.tenant);
        await resumeTenant(context, tenant);
        context.auditTarget("tenant", tenant.id);
        return { ...publicTenant(tenant), status: "active" as const };
      },
    }),
  ];
}
