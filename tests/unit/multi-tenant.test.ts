import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthRuntime } from "@/core/auth/instance";
import { authAccess } from "@/core/auth/access";
import { extensionAuth } from "@/core/extend/auth-call";
import { assertPluginManifest } from "@/core/extend/manifest";
import { definePlugin, type PluginRole } from "@/core/extend/define";
import { scopeablePluginPermissions } from "@/core/authz/permissions";
import { capScopedPermissions } from "@/core/scope/provider";
import { multiTenant, TENANT_ADMIN, TENANT_EDITOR, TENANT_STAFF } from "@tansy/multi-tenant";
import type { ExtensionContext } from "@/core/extend/define";
import { ANONYMOUS } from "@/core/authz/principal";
import { forgetHosts } from "../../plugins/multi-tenant/domains";
import { forgetSlugs, RESERVED_SEGMENTS } from "../../plugins/multi-tenant/paths";
import { roleList, SYSTEM_COLLECTIONS } from "../../plugins/multi-tenant/tenants";

declare const globalThis: { cmsConfig?: { plugins?: unknown[] } } & typeof global;
const original = globalThis.cmsConfig;
afterEach(() => { globalThis.cmsConfig = original; });

const plugin = () => multiTenant({ siteUrl: "https://cms.example.com/" });
const installed = () => { globalThis.cmsConfig = { ...original, plugins: [...(original?.plugins ?? []), plugin()] }; };

describe("multi-tenant manifest", () => {
  it("is valid, and checks its options", () => {
    expect(() => assertPluginManifest(plugin())).not.toThrow();
    expect(() => multiTenant({ siteUrl: "ftp://example.com" })).toThrow();
  });

  it("closes every endpoint of better-auth's organization plugin to HTTP", () => {
    const paths = plugin().auth!.serverOnlyPaths!;
    for (const path of ["/organization/create", "/organization/set-active", "/organization/invite-member", "/organization/accept-invitation", "/organization/update-member-role", "/organization/remove-member", "/organization/has-permission", "/organization/list"]) {
      expect(paths).toContain(path);
    }
    expect(paths.every((path) => path.startsWith("/organization/"))).toBe(true);
  });

  it("keeps its tables system-owned, and lets only tenant roles manage members", () => {
    expect(plugin().systemCollections).toEqual([...SYSTEM_COLLECTIONS, "multi-tenant-domains", "multi-tenant-plans"]);
    expect(plugin().scopedPermissions).toEqual(["ext.multi-tenant:members"]);
    expect(plugin().scope?.everyValue).toBe("ext.multi-tenant:all");
  });

  it("makes tenant roles that hold only what applies in one tenant, and a staff role for every tenant", async () => {
    installed();
    const made: PluginRole[] = [];
    await plugin().migrations![0].up({ roles: { ensure: async (role: PluginRole) => { made.push(role); return true; } } } as never);
    const byName = new Map(made.map((role) => [role.name, role]));
    expect(byName.get(TENANT_ADMIN)?.scope).toBe("scoped");
    expect(byName.get(TENANT_EDITOR)?.scope).toBe("scoped");
    expect(byName.get(TENANT_STAFF)?.scope).toBeUndefined();
    const capped = capScopedPermissions(byName.get(TENANT_ADMIN)!.permissions!, new Set([5]));
    expect(capped.has("ext.multi-tenant:members")).toBe(true);
    expect(capped.has("record:update@c5")).toBe(true);
    expect(capScopedPermissions(["ext.multi-tenant:all", "ext.multi-tenant:create", "role:update"], new Set()).size).toBe(0);
  });

  it("reads better-auth's comma-separated roles", () => {
    expect(roleList(" multi-tenant-admin,,multi-tenant-editor ")).toEqual(["multi-tenant-admin", "multi-tenant-editor"]);
    expect(roleList(null)).toEqual([]);
  });
});

describe("scopedPermissions", () => {
  const base = { version: "1.0.0", apiVersion: 1, permissions: { "ext.acme": ["manage", "all"] } };
  it("takes only a plugin's own permissions, and never one for every value", () => {
    expect(() => assertPluginManifest(definePlugin({ ...base, name: "acme", scopedPermissions: ["ext.acme:manage"] }))).not.toThrow();
    expect(() => assertPluginManifest(definePlugin({ ...base, name: "acme", scopedPermissions: ["ext.acme:all"] }))).toThrow(/every scope value/);
    expect(() => assertPluginManifest(definePlugin({ ...base, name: "acme", scopedPermissions: ["record:delete"] }))).toThrow(/own permissions/);
    expect(() => assertPluginManifest(definePlugin({ ...base, name: "acme", systemCollections: ["posts"] }))).toThrow(/starting with "acme-"/);
    globalThis.cmsConfig = { ...original, plugins: [definePlugin({ ...base, name: "acme", scopedPermissions: ["ext.acme:all"] })] };
    expect(() => scopeablePluginPermissions()).toThrow(/every scope value/);
  });
});

describe("auth.plugins access control", () => {
  const statements = { member: ["create", "update", "delete"], invitation: ["create", "cancel"] } as const;
  const instance = new Map([["editor", new Set(["record:update", "record:read@c4", "setting:update"])]]);
  const scoped = new Map([["tenant-admin", new Set(["record:update", "setting:update", "ext.multi-tenant:members"])], ["tenant-viewer", new Set(["record:read"])]]);

  it("gives a better-auth plugin the CMS's roles, scoped ones capped, with what it grants on its own statements", () => {
    installed();
    const { ac, roles } = authAccess(instance, scoped).accessControl({ statements, roles: "scoped", grant: (held) => (held.has("ext.multi-tenant:members") ? { member: ["create"] } : {}) });
    expect(Object.keys(roles).sort()).toEqual(["tenant-admin", "tenant-viewer"]);
    expect(roles["tenant-admin"].authorize({ member: ["create"] }).success).toBe(true);
    expect(roles["tenant-admin"].authorize({ record: ["update"] }).success).toBe(true);
    // Capped: a scoped role never holds an instance permission, even if it was saved with one.
    expect(roles["tenant-admin"].authorize({ setting: ["update"] }).success).toBe(false);
    expect(roles["tenant-viewer"].authorize({ member: ["create"] }).success).toBe(false);
    expect(ac.statements).toMatchObject(statements);
    const { roles: plain } = authAccess(instance, scoped).accessControl({ roles: "instance" });
    expect(plain.editor.authorize({ setting: ["update"] }).success).toBe(true);
  });

  it("refuses statements that reuse a CMS permission, and grants outside the statements given", () => {
    installed();
    expect(() => authAccess(instance, scoped).accessControl({ statements: { record: ["x"] }, roles: "scoped" })).toThrow(/already one of the CMS's permissions/);
    expect(() => authAccess(instance, scoped).accessControl({ statements, roles: "scoped", grant: () => ({ member: ["destroy"] }) })).toThrow(/isn't among the statements/);
  });
});

describe("context.auth.server", () => {
  function runtime() {
    const own = vi.fn(async (input: unknown) => ({ ok: true, input }));
    const value = {
      auth: { api: { acmeCreate: own, addMember: own, otherThing: own } },
      extensionEndpoints: new Map([["acme", new Map([["/acme/create", "acmeCreate"]])], ["other", new Map([["/other/thing", "otherThing"]])]]),
      extensionEndpointNames: new Map([["acme", new Set(["acmeCreate", "addMember"])], ["other", new Set(["otherThing"])]]),
    } as unknown as AuthRuntime;
    return { value, own };
  }

  it("calls the plugin's own endpoints with no caller at all, by path or by name", async () => {
    const { value, own } = runtime();
    const auth = extensionAuth(value, "plugin:acme", new Headers({ cookie: "session=abc", "x-api-key": "key" }));
    await auth.server("/acme/create", { body: { userId: "u1" } });
    await auth.server("addMember", { body: { userId: "u1" } });
    for (const [input] of own.mock.calls as Array<[Record<string, unknown>]>) {
      expect(input).not.toHaveProperty("headers");
      expect(input.body).toEqual({ userId: "u1" });
    }
  });

  it("can't reach another plugin's endpoints, core's, or any from a hook file", async () => {
    const { value, own } = runtime();
    const auth = extensionAuth(value, "plugin:acme", new Headers());
    await expect(auth.server("/other/thing")).rejects.toThrow(/added no better-auth endpoint/);
    await expect(auth.server("otherThing")).rejects.toThrow(/added no better-auth endpoint/);
    await expect(auth.server("signInEmail")).rejects.toThrow(/added no better-auth endpoint/);
    await expect(extensionAuth(value, "hooks:x.ts", new Headers()).server("addMember")).rejects.toThrow(/hook file/);
    expect(own).not.toHaveBeenCalled();
  });
});

/**
 * Which tenant a request is for. A verified domain decides for everyone; below it, a first path
 * segment naming a tenant serves that tenant's site on the instance's own address. See
 * MULTI_TENANT_PLAN.md, "A tenant's path prefix".
 */
describe("resolving a tenant from a path prefix", () => {
  /** Acme has a verified domain and the short name "acme". Globex has only its short name. */
  const context = {
    system: {
      records: {
        list: async (slug: string) => {
          if (slug === "multi-tenant-domains") return { items: [{ id: 1, host: "acme.example.test", organizationId: "t-acme", primary: true, token: "x", verifiedAt: "2026-01-01T00:00:00.000Z" }], totalPages: 1 };
          if (slug === "multi-tenant-organization") {
            return {
              items: [
                { id: 1, authId: "t-acme", name: "Acme", slug: "acme", organizationStatus: "active" },
                { id: 2, authId: "t-globex", name: "Globex", slug: "globex", organizationStatus: "active" },
                { id: 3, authId: "t-closed", name: "Closed", slug: "closed", organizationStatus: "suspended" },
              ],
              totalPages: 1,
            };
          }
          return { items: [], totalPages: 1 };
        },
      },
    },
  } as unknown as ExtensionContext;

  const resolve = (host: string | null, path: string) => {
    forgetHosts();
    forgetSlugs();
    return plugin().scope!.resolve({ host, headers: new Headers(), path, principal: ANONYMOUS }, context);
  };

  it("serves a tenant with no domain under its short name on the instance's address", async () => {
    expect(await resolve("cms.example.com", "/globex/pages/home")).toBe("t-globex");
    expect(await resolve("cms.example.com", "/globex")).toBe("t-globex");
    // A tenant that is closed, and a segment that is no tenant's short name, name nothing.
    expect(await resolve("cms.example.com", "/closed/pages/home")).toBe(null);
    expect(await resolve("cms.example.com", "/pages/home")).toBe(null);
    expect(await resolve("cms.example.com", "/")).toBe(null);
  });

  it("lets a verified domain decide for everyone, whatever the path says", async () => {
    expect(await resolve("acme.example.test", "/pages/home")).toBe("t-acme");
    // The policy: a path can never move a visitor off a tenant's own domain onto another tenant.
    expect(await resolve("acme.example.test", "/globex/pages/home")).toBe("t-acme");
    // A tenant keeps its prefix once it verifies a domain, so links shared before it still work.
    expect(await resolve("cms.example.com", "/acme/pages/home")).toBe("t-acme");
  });

  it("never serves a tenant under an address the CMS answers on itself", async () => {
    expect(RESERVED_SEGMENTS.has("api")).toBe(true);
    expect(RESERVED_SEGMENTS.has("dashboard")).toBe(true);
    expect(await resolve("cms.example.com", "/api/collections/1/content")).toBe(null);
    expect(await resolve("cms.example.com", "/dashboard/collections")).toBe(null);
  });

  it("tells core where each tenant's site is served, and nothing for one that is closed", async () => {
    forgetSlugs();
    const basePath = plugin().scope!.basePath!;
    expect(await basePath("t-globex", context)).toBe("/globex");
    expect(await basePath("t-acme", context)).toBe("/acme");
    expect(await basePath("t-closed", context)).toBe(null);
    expect(await basePath("t-missing", context)).toBe(null);
  });
});
