import { beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolContext, RecordValues } from "tansy/plugin";
import { DOMAINS } from "../../plugins/multi-tenant/domains";
import { PLANS } from "../../plugins/multi-tenant/lifecycle";
import { tenantRoutes } from "../../plugins/multi-tenant/routes";
import { MEMBERS, ORGANIZATIONS } from "../../plugins/multi-tenant/tenants";
import { tenantTools } from "../../plugins/multi-tenant/tools";

const EVERY_TENANT = "ext.multi-tenant:all";

/** A records store that understands the filters these tools write: `a = "x"`, joined by `||`. */
function fakeContext() {
  const tables = new Map<string, RecordValues[]>();
  let next = 1;
  const rows = (slug: string) => tables.get(slug) ?? tables.set(slug, []).get(slug)!;
  const matches = (row: RecordValues, filter: string) => !filter || filter.split(" || ").some((part) => {
    const [, field, op, raw] = /^(\w+) (=|!=) (null|"[^"]*")$/.exec(part.trim())!;
    const value = raw === "null" ? null : raw.slice(1, -1);
    const have = row[field] ?? null;
    return op === "=" ? have === value : have !== value;
  });
  const records = {
    list: async (slug: string, query: { filter?: string; perPage?: number; page?: number }) => {
      const items = rows(slug).filter((row) => matches(row, query.filter ?? ""));
      const perPage = query.perPage ?? 30;
      const page = query.page ?? 1;
      return { items: items.slice((page - 1) * perPage, page * perPage), page, perPage, totalItems: items.length, totalPages: Math.max(1, Math.ceil(items.length / perPage)) };
    },
    create: async (slug: string, data: RecordValues) => {
      const row = { ...data, id: next++ };
      rows(slug).push(row);
      return row;
    },
    update: async (slug: string, id: number, patch: RecordValues) => {
      const row = rows(slug).find((item) => item.id === id)!;
      Object.assign(row, patch);
      return row;
    },
    delete: async (slug: string, id: number) => { tables.set(slug, rows(slug).filter((item) => item.id !== id)); },
  };

  const people = new Map<string, { id: string; name: string; email: string }>();
  const audited: Array<{ type: string; id: string; metadata?: Record<string, unknown> }> = [];

  /** The context one tool call gets, as whoever `principal` says. */
  const contextFor = (input: unknown, principal: { permissions: string[]; scope?: string | null; id?: string }) => ({
    input,
    principal: {
      kind: "user",
      user: { id: principal.id ?? "staff", email: `${principal.id ?? "staff"}@example.test` },
      permissions: new Set(principal.permissions),
      scope: principal.scope ?? null,
    },
    auditTarget: (type: string, id: string, metadata?: Record<string, unknown>) => { audited.push({ type, id, metadata }); },
    system: { records, users: { get: async (id: string) => people.get(id) ?? null } },
    scope: {
      forgetLimits: async () => {},
      data: { usage: async () => ({ records: 4, storageBytes: 1024 }) },
    },
  } as unknown as AgentToolContext);

  const tenant = async (id: string, status: "active" | "suspended" = "active") => {
    await records.create(ORGANIZATIONS, { authId: id, name: id.toUpperCase(), slug: id, organizationStatus: status });
  };
  const member = async (tenantId: string, userId: string, roles: string[]) => {
    await records.create(MEMBERS, { authId: `m-${tenantId}-${userId}`, organizationId: tenantId, userId, role: roles.join(",") });
    people.set(userId, { id: userId, name: userId.toUpperCase(), email: `${userId}@example.test` });
  };
  return { records, rows, people, audited, contextFor, tenant, member };
}

const tools = tenantTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const run = <T,>(tool: AgentTool, context: AgentToolContext) => tool.handler(context) as Promise<T>;
const permissionOf = (tool: AgentTool) => (tool.access.access === "permission" ? tool.access.permission : "authenticated");

let fake: ReturnType<typeof fakeContext>;
beforeEach(() => { fake = fakeContext(); });

describe("what the tenant tools may do", () => {
  it("name the permission each one needs, and the audit action of each write", () => {
    expect(tools.map((tool) => ({ name: tool.name, access: permissionOf(tool), write: tool.write, audit: tool.audit ?? null }))).toEqual([
      { name: "multi_tenant_list_tenants", access: "authenticated", write: false, audit: null },
      { name: "multi_tenant_describe_tenant", access: "ext.multi-tenant:read", write: false, audit: null },
      { name: "multi_tenant_list_domains", access: "ext.multi-tenant:domains", write: false, audit: null },
      { name: "multi_tenant_list_members", access: "ext.multi-tenant:members", write: false, audit: null },
      { name: "multi_tenant_suspend_tenant", access: "ext.multi-tenant:delete", write: true, audit: "multi_tenant.suspend" },
      { name: "multi_tenant_resume_tenant", access: "ext.multi-tenant:delete", write: true, audit: "multi_tenant.resume" },
    ]);
  });

  /**
   * The rule the tools are built on. A tool call shows no recent sign-in and comes from a model, so
   * a tool may only do what an API key may already do on one of this plugin's routes, under the
   * same permission. Anything a route guards with `fresh` — making a tenant, its limits, a purge —
   * has no tool, and never gets one by someone copying a route's permission across.
   */
  it("does only what an API key may do on a route, under the same permission", () => {
    const open = new Set(
      tenantRoutes({ siteUrl: "https://cms.example" })
        .filter((route) => route.apiKey && !route.fresh)
        .map((route) => (route.access === "permission" ? route.permission : "authenticated")),
    );
    for (const tool of tools) {
      expect(open, `${tool.name} needs a route an API key may call`).toContain(permissionOf(tool));
    }
  });

  it("has no tool for a purge, an export or an import", () => {
    expect([...byName.keys()].join(" ")).not.toMatch(/purge|export|import|create|limit/);
  });

  it("gives every write an audit action, as core requires", () => {
    for (const tool of tools) expect(Boolean(tool.audit), tool.name).toBe(tool.write);
  });

  it("takes no tenant from the model where the tenant must be the caller's own", () => {
    for (const name of ["multi_tenant_list_domains", "multi_tenant_list_members"]) {
      expect(Object.keys(byName.get(name)!.input.parse({}) as object)).toEqual([]);
    }
  });
});

describe("multi_tenant_list_tenants", () => {
  it("gives a member their own tenants only", async () => {
    await fake.tenant("alpha");
    await fake.tenant("beta");
    await fake.member("alpha", "ann", ["multi-tenant-admin"]);
    const result = await run<{ current: string | null; items: Array<{ id: string; roles: string[] }> }>(
      byName.get("multi_tenant_list_tenants")!,
      fake.contextFor({}, { id: "ann", permissions: ["dashboard:access"], scope: "alpha" }),
    );
    expect(result.items.map((item) => item.id)).toEqual(["alpha"]);
    expect(result.items[0].roles).toEqual(["multi-tenant-admin"]);
    expect(result.current).toBe("alpha");
  });

  it("gives staff who reach every tenant all of them, suspended ones included", async () => {
    await fake.tenant("alpha");
    await fake.tenant("beta", "suspended");
    const result = await run<{ items: Array<{ id: string; status: string }> }>(
      byName.get("multi_tenant_list_tenants")!,
      fake.contextFor({}, { permissions: [EVERY_TENANT] }),
    );
    expect(result.items.map((item) => `${item.id}:${item.status}`)).toEqual(["alpha:active", "beta:suspended"]);
  });
});

describe("multi_tenant_describe_tenant", () => {
  it("reports limits and usage, and leaves domains to the domains permission", async () => {
    await fake.tenant("alpha");
    await fake.member("alpha", "ann", ["multi-tenant-admin"]);
    await fake.records.create(PLANS, { organizationId: "alpha", records: 10, storageBytes: 2048, members: 3, requestsPerMinute: 60 });
    await fake.records.create(DOMAINS, { organizationId: "alpha", host: "alpha.example", token: "secret-token-value", verifiedAt: "2026-01-01T00:00:00.000Z" });

    const result = await run<Record<string, unknown>>(
      byName.get("multi_tenant_describe_tenant")!,
      fake.contextFor({ tenant: "alpha" }, { permissions: ["ext.multi-tenant:read"] }),
    );
    expect(result).toMatchObject({
      id: "alpha",
      limits: { records: 10, storageBytes: 2048, members: 3, requestsPerMinute: 60 },
      usage: { records: 4, storageBytes: 1024, members: 1 },
      purgeAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("alpha.example");
  });

  it("answers the same for a tenant that doesn't exist and for an id that can't be one", async () => {
    const tool = byName.get("multi_tenant_describe_tenant")!;
    for (const id of ["missing", "not an id"]) {
      await expect(run(tool, fake.contextFor({ tenant: id }, { permissions: ["ext.multi-tenant:read"] })))
        .rejects.toThrow("Tenant not found.");
    }
  });
});

describe("multi_tenant_list_domains", () => {
  it("lists the tenant being worked in, with each claim's state and never its token", async () => {
    await fake.tenant("alpha");
    await fake.records.create(DOMAINS, { organizationId: "alpha", host: "alpha.example", token: "secret-token-value", primary: true, verifiedAt: "2026-01-01T00:00:00.000Z" });
    await fake.records.create(DOMAINS, { organizationId: "alpha", host: "claim.example", token: "another-secret", primary: false, verifiedAt: null });
    await fake.records.create(DOMAINS, { organizationId: "beta", host: "beta.example", token: "beta-secret", primary: true, verifiedAt: "2026-01-01T00:00:00.000Z" });

    const result = await run<{ items: Array<{ host: string; verified: boolean; primary: boolean }> }>(
      byName.get("multi_tenant_list_domains")!,
      fake.contextFor({}, { permissions: ["ext.multi-tenant:domains"], scope: "alpha" }),
    );
    expect(result.items.map((item) => `${item.host}:${item.verified}:${item.primary}`)).toEqual(["alpha.example:true:true", "claim.example:false:false"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("asks for a tenant first when the caller is working in none", async () => {
    await expect(run(byName.get("multi_tenant_list_domains")!, fake.contextFor({}, { permissions: ["ext.multi-tenant:domains"], scope: null })))
      .rejects.toThrow("Choose a tenant first");
  });
});

describe("multi_tenant_list_members", () => {
  it("lists the tenant being worked in, with no way to ask for another", async () => {
    await fake.tenant("alpha");
    await fake.tenant("beta");
    await fake.member("alpha", "ann", ["multi-tenant-admin"]);
    await fake.member("beta", "bob", ["multi-tenant-editor"]);
    const result = await run<{ tenant: { id: string }; items: Array<{ email: string | null }> }>(
      byName.get("multi_tenant_list_members")!,
      fake.contextFor({}, { id: "ann", permissions: ["ext.multi-tenant:members"], scope: "alpha" }),
    );
    expect(result.tenant.id).toBe("alpha");
    expect(result.items.map((item) => item.email)).toEqual(["ann@example.test"]);
  });
});

describe("suspending and resuming", () => {
  it("changes the tenant's status, and names it in the audit entry", async () => {
    await fake.tenant("alpha");
    const staff = { permissions: ["ext.multi-tenant:delete"] };
    expect(await run<{ status: string }>(byName.get("multi_tenant_suspend_tenant")!, fake.contextFor({ tenant: "alpha" }, staff))).toMatchObject({ status: "suspended" });
    expect(fake.rows(ORGANIZATIONS)[0].organizationStatus).toBe("suspended");
    expect(await run<{ status: string }>(byName.get("multi_tenant_resume_tenant")!, fake.contextFor({ tenant: "alpha" }, staff))).toMatchObject({ status: "active" });
    expect(fake.rows(ORGANIZATIONS)[0].organizationStatus).toBe("active");
    expect(fake.audited.map((entry) => `${entry.type}:${entry.id}`)).toEqual(["tenant:alpha", "tenant:alpha"]);
  });

  it("leaves a suspended tenant suspended rather than failing", async () => {
    await fake.tenant("alpha", "suspended");
    expect(await run<{ status: string }>(byName.get("multi_tenant_suspend_tenant")!, fake.contextFor({ tenant: "alpha" }, { permissions: ["ext.multi-tenant:delete"] }))).toMatchObject({ status: "suspended" });
  });
});
