import { randomUUID } from "node:crypto";
import { z } from "zod";
import { definePlugin, defineRoute, type ExtensionContext, type PluginRole } from "tansy/plugin";
import { ACCESS, ENTITLEMENTS, grantEnd, MANUAL, MEMBERSHIPS, PLAN_NAME, PLANS } from "./logic";
import { messages } from "./messages";

export { gated, gateOf, ungated, gateCondition } from "./logic";

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
const str = (value: unknown) => (typeof value === "string" ? value : "");

type Row = Record<string, unknown>;

async function listAll(context: ExtensionContext, slug: string, query: { filter?: string; fields?: string; sort?: string }, limit = 2000) {
  const items: Row[] = [];
  for (let page = 1; items.length < limit; page++) {
    const result = await context.system.records.list(slug, { ...query, page, perPage: 200 });
    items.push(...result.items);
    if (page >= (result.totalPages ?? 1) || !result.items.length) break;
  }
  return items.slice(0, limit);
}

/** Runs the subscriptions and changes who's on which plan, without touching money, which stays with Payments. */
export function subscriptionsRoles(): PluginRole[] {
  return [{
    name: "subscriptions-manager",
    label: "Subscriptions manager",
    description: "Edits plans and access, gates collections, sees who's subscribed, and gives or ends free plans.",
    permissions: ["dashboard:access", "collection:read", "collection:update", "collection:manage-rules", "ext.subscriptions:manage"],
    records: {
      [PLANS]: ["list", "read", "create", "update", "delete"],
      [ACCESS]: ["list", "read", "create", "update", "delete"],
      [ENTITLEMENTS]: ["list", "read"],
      [MEMBERSHIPS]: ["list", "read"],
    },
  }];
}

/** Ends free plans whose time is up. Payments' own hook then takes their access away. */
async function endExpiredGrants(context: ExtensionContext) {
  const now = new Date().toISOString();
  const due = await listAll(context, MEMBERSHIPS, { filter: `provider = "${MANUAL}" && state = "active" && periodEnd != null && periodEnd <= "${now}"`, fields: "id" });
  for (const row of due) await context.system.records.update(MEMBERSHIPS, row.id as number, { state: "expired", eventAt: Date.now() }, { if: { state: "active" } });
}

/**
 * One place to run subscriptions: plans, what they open, who's on them, and gating any
 * collection, in its own section of the dashboard. Built on the Payments plugin, whose plans,
 * access and memberships it manages, and on core's collection and rule APIs. See
 * docs/plugins/subscriptions.md.
 */
export function subscriptions() {
  return definePlugin({
    name: "subscriptions",
    version: "0.1.1",
    messages,
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { server: "@tansy/subscriptions/admin" },
    permissions: { "ext.subscriptions": ["manage"] },
    jobs: [{ name: "subscriptions-end-grants", cron: "*/15 * * * *", handler: endExpiredGrants }],
    routes: [
      defineRoute({
        method: "GET",
        path: "/members",
        access: "permission",
        permission: "ext.subscriptions:manage",
        handler: async (context) => {
          const [entitlements, grants] = await Promise.all([
            listAll(context, ENTITLEMENTS, { fields: "user,plans,access,updatedAt", sort: "-updatedAt" }),
            listAll(context, MEMBERSHIPS, { filter: `provider = "${MANUAL}"`, fields: "id,user,plan,state,periodEnd,createdAt", sort: "-createdAt" }),
          ]);
          const ids = [...new Set([...entitlements, ...grants].map((row) => str(row.user)).filter(Boolean))];
          const people = new Map((await Promise.all(ids.map((id) => context.system.users.get(id)))).filter((user) => user !== null).map((user) => [user.id, user]));
          const members = ids.map((id) => {
            const entitlement = entitlements.find((row) => row.user === id);
            const person = people.get(id);
            return {
              user: id,
              name: person?.name ?? "",
              email: person?.email ?? "",
              plans: Array.isArray(entitlement?.plans) ? entitlement.plans : [],
              access: Array.isArray(entitlement?.access) ? entitlement.access : [],
              updatedAt: entitlement?.updatedAt ?? null,
              grants: grants.filter((grant) => grant.user === id).map((grant) => ({ id: grant.id, plan: grant.plan, state: grant.state, periodEnd: grant.periodEnd ?? null })),
            };
          });
          return { members };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/grant",
        access: "permission",
        permission: "ext.subscriptions:manage",
        audit: "subscriptions.grant",
        rateLimit: { window: 60, max: 30 },
        body: z.strictObject({ email: z.string().trim().email().max(320), plan: z.string().trim().toLowerCase().max(60), until: z.string().max(40).nullable().optional() }),
        handler: async (context) => {
          const { email, plan, until } = context.body;
          if (!PLAN_NAME.test(plan)) return refuse(400, "VALIDATION_FAILED", "That isn't a plan name.");
          const end = grantEnd(until);
          if (end === "invalid") return refuse(400, "VALIDATION_FAILED", "Choose an end date in the future, or none.");
          const { items } = await context.system.records.list(PLANS, { filter: `name = "${plan}"`, perPage: 1, fields: "id" });
          if (!items.length) return refuse(404, "NOT_FOUND", "There's no such plan.");
          const person = await context.system.users.findByEmail(email);
          if (!person) return refuse(404, "NOT_FOUND", "Nobody has an account with that email. They need to sign up first.");
          // A membership like a provider's, so Payments works out their access the same way.
          const grant = await context.system.records.create(MEMBERSHIPS, {
            status: "published", provider: MANUAL, subscriptionId: `${MANUAL}_${randomUUID()}`, user: person.id, plan, state: "active", periodEnd: end, eventAt: Date.now(),
          }, { owner: person.id });
          context.auditTarget("user", person.id, { plan, until: end });
          return { grant: { id: grant.id, plan, state: "active", periodEnd: end } };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/grants/:id/end",
        access: "permission",
        permission: "ext.subscriptions:manage",
        audit: "subscriptions.end_grant",
        handler: async (context) => {
          const id = Number(context.params.id);
          if (!Number.isSafeInteger(id) || id <= 0) return refuse(404, "NOT_FOUND", "There's no such free plan.");
          const grant = await context.system.records.get(MEMBERSHIPS, id, { fields: "id,provider,user,plan,state" }).catch(() => null);
          // Only grants given here. A provider's subscription ends with the provider, or Payments would be out of step with it.
          if (!grant || grant.provider !== MANUAL) return refuse(404, "NOT_FOUND", "There's no such free plan.");
          if (grant.state === "active") await context.system.records.update(MEMBERSHIPS, id, { state: "canceled", eventAt: Date.now() }, { if: { state: "active" } });
          context.auditTarget("user", str(grant.user), { plan: grant.plan });
          return { ended: true };
        },
      }),
    ],
    migrations: [{
      id: "001-role",
      up: async ({ schema, roles }) => {
        if (!(await schema.describe(ACCESS))) throw new Error("The subscriptions plugin needs the Payments plugin, listed before it in tansy.config.ts, at version 0.3.0 or later.");
        for (const role of subscriptionsRoles()) await roles.ensure(role);
      },
    }],
  });
}
