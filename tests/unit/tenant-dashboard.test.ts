import { afterEach, describe, expect, it } from "vitest";
import { pluginNav } from "@/core/extend/admin-nav";
import type { AdminConfig } from "@/core/extend/admin";
import type { ExtensionRoute, ExtensionRouteContext, PluginRole } from "@/core/extend/define";
import { capScopedPermissions, isScopeablePermission } from "@/core/scope/provider";
import { multiTenant, TENANT_ADMIN, TENANT_EDITOR } from "@tansy/multi-tenant";
import { messages } from "../../plugins/multi-tenant/messages";
import { MEMBERS, ORGANIZATIONS } from "../../plugins/multi-tenant/tenants";

declare const globalThis: { cmsConfig?: { plugins?: unknown[] }; cmsAdminConfig?: AdminConfig } & typeof global;
const originalConfig = globalThis.cmsConfig;
const originalAdmin = globalThis.cmsAdminConfig;
afterEach(() => {
  globalThis.cmsConfig = originalConfig;
  globalThis.cmsAdminConfig = originalAdmin;
});

const plugin = () => multiTenant({ siteUrl: "https://cms.example.com" });
const route = (method: string, path: string) => plugin().routes!.find((item) => item.method === method && item.path === path) as ExtensionRoute;

describe("the top bar's switcher", () => {
  const install = (switcher: NonNullable<AdminConfig["plugins"][number]["switcher"]>) => {
    globalThis.cmsConfig = { ...originalConfig, plugins: [plugin()] };
    globalThis.cmsAdminConfig = { plugins: [{ name: "multi-tenant", switcher }], synced: [] };
  };

  it("points at the plugin's own routes", async () => {
    install({ label: "Tenant", options: "/switcher", select: "/switcher" });
    const { switchers } = await pluginNav(new Set(["dashboard:access"]));
    expect(switchers).toEqual([{ plugin: "multi-tenant", label: "Tenant", options: "/api/ext/multi-tenant/switcher", select: "/api/ext/multi-tenant/switcher" }]);
  });

  it("is left out when a route it names isn't the plugin's, or the person lacks its permission", async () => {
    install({ label: "Tenant", options: "/missing", select: "/switcher" });
    expect((await pluginNav(new Set(["dashboard:access"]))).switchers).toEqual([]);
    install({ label: "Tenant", options: "/switcher", select: "/switcher", permission: "ext.multi-tenant:read" });
    expect((await pluginNav(new Set(["dashboard:access"]))).switchers).toEqual([]);
    expect((await pluginNav(new Set(["dashboard:access", "ext.multi-tenant:read"]))).switchers).toHaveLength(1);
  });
});

describe("scoped roles and the dashboard", () => {
  it("may read the shared schema, which record pages need, but never change it", () => {
    expect(isScopeablePermission("collection:read")).toBe(true);
    const capped = capScopedPermissions(["collection:read", "collection:update", "collection:create", "role:list", "setting:read"], new Set());
    expect([...capped]).toEqual(["collection:read"]);
  });

  it("gives tenant admins and editors what they need to open the dashboard in their tenant", async () => {
    globalThis.cmsConfig = { ...originalConfig, plugins: [plugin()] };
    const made: PluginRole[] = [];
    await plugin().migrations![0].up({ roles: { ensure: async (role: PluginRole) => { made.push(role); return true; } } } as never);
    for (const name of [TENANT_ADMIN, TENANT_EDITOR]) {
      const role = made.find((item) => item.name === name)!;
      expect(role.permissions).toEqual(expect.arrayContaining(["dashboard:access", "collection:read", "record:list"]));
      expect(role.permissions!.every(isScopeablePermission)).toBe(true);
    }
  });
});

describe("the plugin's dashboard words", () => {
  const keys = (value: unknown, prefix = ""): string[] => (value && typeof value === "object"
    ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${prefix}${key}.`))
    : [prefix.slice(0, -1)]);

  it("are in English and Arabic, with the same keys", () => {
    expect(keys(messages.ar).sort()).toEqual(keys(messages.en).sort());
  });

  it("name every page, the section, the switcher and the scope", () => {
    for (const key of ["section", "switcher", "scopeLabel", "pages.tenants", "pages.tenants/members", "settings.invitationDays.label"]) expect(keys(messages.en)).toContain(key);
  });
});

/** Rows by collection, filtered the way the plugin writes filters: `field = "value"` joined by && or ||. */
function fakeContext(rows: Record<string, Array<Record<string, unknown>>>, principal: ExtensionRouteContext["principal"], locale = "en") {
  const matches = (row: Record<string, unknown>, filter: string) => {
    if (!filter) return true;
    const test = (part: string) => { const [, field, value] = /^\s*(\w+) = "([^"]*)"\s*$/.exec(part)!; return row[field] === value; };
    return filter.includes("||") ? filter.split("||").some(test) : filter.split("&&").every(test);
  };
  const switched: Array<string | null> = [];
  const audited: unknown[] = [];
  const context = {
    principal,
    system: {
      records: {
        list: async (slug: string, query: { filter?: string }) => {
          const items = (rows[slug] ?? []).filter((row) => matches(row, query.filter ?? ""));
          return { items, page: 1, perPage: 200, totalItems: items.length, totalPages: 1 };
        },
        update: async (_slug: string, _id: number, values: { activeOrganizationId?: string | null }) => { switched.push(values.activeOrganizationId ?? null); },
        create: async (_slug: string, values: { activeOrganizationId?: string | null }) => { switched.push(values.activeOrganizationId ?? null); },
      },
      users: { get: async () => ({ id: "u1", name: "U", email: "u@example.com", locale }) },
    },
    auditTarget: (...args: unknown[]) => { audited.push(args); },
  } as unknown as ExtensionRouteContext;
  return { context, switched, audited };
}

const tenants = [
  { id: 1, authId: "acme", name: "Acme", slug: "acme", organizationStatus: "active" },
  { id: 2, authId: "zeta", name: "Zeta", slug: "zeta", organizationStatus: "active" },
  { id: 3, authId: "gone", name: "Gone", slug: "gone", organizationStatus: "suspended" },
];
const user = (permissions: string[], scope: string | null = null) => ({
  kind: "user", permissions: new Set(permissions), scope,
  user: { id: "u1", email: "u@example.com", name: "U" },
  session: { id: "s1", createdAt: new Date(), impersonatedBy: null },
}) as unknown as ExtensionRouteContext["principal"];

describe("the switcher's routes", () => {
  it("offer a member only the active tenants they belong to", async () => {
    const { context } = fakeContext({ [ORGANIZATIONS]: tenants, [MEMBERS]: [{ id: 9, authId: "m1", organizationId: "zeta", userId: "u1", role: TENANT_EDITOR }] }, user(["dashboard:access"], "zeta"));
    expect(await route("GET", "/switcher").handler(context)).toEqual({ current: "zeta", options: [{ value: "zeta", label: "Zeta" }] });
  });

  it("offer staff every active tenant, and none, named in their language", async () => {
    const { context } = fakeContext({ [ORGANIZATIONS]: tenants, [MEMBERS]: [] }, user(["dashboard:access", "ext.multi-tenant:all", "ext.multi-tenant:read"]), "ar");
    expect(await route("GET", "/switcher").handler(context)).toEqual({ current: null, options: [{ value: null, label: messages.ar.switcherNone }, { value: "acme", label: "Acme" }, { value: "zeta", label: "Zeta" }] });
  });

  it("switch only to a tenant the caller can reach, with the same answer as one that doesn't exist", async () => {
    const outsider = fakeContext({ [ORGANIZATIONS]: tenants, [MEMBERS]: [] }, user(["dashboard:access"]));
    for (const value of ["acme", "missing"]) {
      await expect(route("POST", "/switcher").handler({ ...outsider.context, body: { value } } as never)).rejects.toMatchObject({ status: 404, code: "SCOPE_NOT_FOUND" });
    }
    expect(outsider.switched).toEqual([]);
    const member = fakeContext({ [ORGANIZATIONS]: tenants, [MEMBERS]: [{ id: 9, authId: "m1", organizationId: "acme", userId: "u1", role: TENANT_EDITOR }] }, user(["dashboard:access"]));
    expect(await route("POST", "/switcher").handler({ ...member.context, body: { value: "acme" } } as never)).toEqual({ current: "acme" });
    expect(member.switched).toEqual(["acme"]);
    await expect(route("POST", "/switcher").handler({ ...member.context, body: { value: "gone" } } as never)).rejects.toMatchObject({ status: 404 });
  });
});
