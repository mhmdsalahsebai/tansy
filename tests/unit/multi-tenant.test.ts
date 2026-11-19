import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthRuntime } from "@/core/auth/instance";
import { authAccess } from "@/core/auth/access";
import { extensionAuth } from "@/core/extend/auth-call";
import { assertPluginManifest } from "@/core/extend/manifest";
import { definePlugin, type PluginRole } from "@/core/extend/define";
import { scopeablePluginPermissions } from "@/core/authz/permissions";
import { capScopedPermissions } from "@/core/scope/provider";
import { multiTenant, TENANT_ADMIN, TENANT_EDITOR, TENANT_STAFF } from "@tansy/multi-tenant";
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
