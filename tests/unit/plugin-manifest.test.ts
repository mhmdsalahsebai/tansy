import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AdminAccess, AdminClientProvider, flattenPlugins, useAdminSlots } from "@/components/admin-client";
import { PluginBoundary, runPluginAction } from "@/components/PluginBoundary";
import type { CmsConfig } from "@/core/auth/extensions";
import type { AdminClientPlugin } from "@/core/extend/admin";
import { PLUGIN_API_VERSION, type CmsPlugin, type ExtensionRoute } from "@/core/extend/define";
import { assertPluginManifest, pendingMigrations, pluginPrefix, pluginRoutes } from "@/core/extend/manifest";
import { isOlder, satisfies } from "@/core/extend/semver";
import { defineField } from "@/core/fields/define";
import { TANSY_VERSION } from "@/core/version";
import { assertMapsMatch } from "../../packages/cms/routes/pages";

const plugin = (extra: Partial<CmsPlugin> = {}): CmsPlugin => ({ name: "acme-tools", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, ...extra });
const route = (extra: object = {}) => ({ method: "GET", path: "/stats", access: "authenticated", handler: () => undefined, ...extra }) as unknown as ExtensionRoute;
const field = (type: string) => defineField({ type, admin: { label: type, input: "text" }, config: {}, value: () => z.string(), storage: () => ({ sql: "text" }) });

describe("version ranges", () => {
  it("accepts the forms plugins declare", () => {
    expect(satisfies("1.4.2", "*")).toBe(true);
    expect(satisfies("1.4.2", "1.4.2")).toBe(true);
    expect(satisfies("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfies("1.4.2", "~1.4.0")).toBe(true);
    expect(satisfies("3.0.0", ">=1.0.0")).toBe(true);
  });
  it("refuses what they exclude", () => {
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("1.1.0", "^1.2.0")).toBe(false);
    expect(satisfies("1.5.0", "~1.4.0")).toBe(false);
    expect(satisfies("0.2.0", "^0.1.0")).toBe(false);
    expect(satisfies("0.0.2", "^0.0.1")).toBe(false);
  });
  it("won't guess at a range it can't read", () => {
    for (const bad of ["latest", "1.x", "^1", ">1.0.0 <2.0.0"]) expect(() => satisfies("1.0.0", bad), bad).toThrow(/Invalid version range/);
  });
});

describe("plugin manifest", () => {
  it("states this package's real version", () => {
    expect(TANSY_VERSION).toBe(JSON.parse(readFileSync("packages/cms/package.json", "utf8")).version);
  });
  it("accepts a complete plugin", () => expect(() => assertPluginManifest(plugin({ requires: { cms: "^1.0.0" } }), "1.3.0")).not.toThrow());

  // The runtime reads the version in the code and records it per install, while npm serves the one in
  // package.json. A release sets both with scripts/set-version.mjs; this fails if they ever part.
  it("keeps each package's declared version and CMS range in step with its manifest", () => {
    const folders = ["plugins", "themes", "examples"].flatMap((group) => readdirSync(group).map((name) => `${group}/${name}`));
    for (const folder of folders) {
      if (!existsSync(`${folder}/index.ts`)) continue;
      const { name, version } = JSON.parse(readFileSync(`${folder}/package.json`, "utf8"));
      const source = readFileSync(`${folder}/index.ts`, "utf8");
      const declared = /(?<![A-Za-z])version: "(\d+\.\d+\.\d+)"/.exec(source)?.[1];
      if (declared) expect(declared, `${name} declares ${declared} and its manifest says ${version}`).toBe(version);
      const range = /requires: \{ cms: "([^"]+)" \}/.exec(source)?.[1];
      if (range) expect(satisfies(TANSY_VERSION, range), `${name} requires tansy ${range}, and this is ${TANSY_VERSION}`).toBe(true);
    }
  });

  it("names components on every page after the plugin, each with a function for its props", () => {
    expect(() => assertPluginManifest(plugin({ everyPage: { "acme-tools-banner": () => ({}) } }))).not.toThrow();
    expect(() => assertPluginManifest(plugin({ everyPage: { banner: () => ({}) } }))).toThrow(/everyPage "banner" must be .* starting with "acme-tools-"/);
    expect(() => assertPluginManifest(plugin({ everyPage: { "acme-tools-Banner": () => ({}) } }))).toThrow(/everyPage "acme-tools-Banner"/);
    expect(() => assertPluginManifest(plugin({ everyPage: { "acme-tools-banner": {} as never } }))).toThrow(/needs a function/);
  });
  it("stops on the wrong plugin API, naming the plugin", () => {
    expect(() => assertPluginManifest(plugin({ apiVersion: 99 }))).toThrow(/Plugin "acme-tools".*plugin API 99/);
  });
  it("stops when the plugin needs another CMS version", () => {
    expect(() => assertPluginManifest(plugin({ requires: { cms: "^2.0.0" } }), "1.3.0")).toThrow(/requires tansy \^2\.0\.0, and this is 1\.3\.0/);
    expect(() => assertPluginManifest(plugin({ requires: { cms: "latest" } }), "1.3.0")).toThrow(/requires\.cms/);
  });
  it("needs a real name and version", () => {
    for (const name of ["Acme", "a/b", "../x", ""]) expect(() => assertPluginManifest(plugin({ name })), name).toThrow(/name/);
    expect(() => assertPluginManifest(plugin({ version: "new" }))).toThrow(/version/);
    expect(() => assertPluginManifest(plugin({ version: undefined as unknown as string }))).toThrow(/version/);
  });
  it("makes field types and blocks carry the plugin's prefix", () => {
    expect(pluginPrefix("acme-tools")).toBe("acme_tools_");
    expect(() => assertPluginManifest(plugin({ fields: [field("acme_tools_link")] }))).not.toThrow();
    expect(() => assertPluginManifest(plugin({ fields: [field("link")] }))).toThrow(/must start with "acme_tools_"/);
    expect(() => assertPluginManifest(plugin({ blocks: [{ name: "faq", label: "FAQ", fields: [] }] }))).toThrow(/must start with "acme_tools_"/);
  });
  it("validates options, and says which one is wrong", () => {
    const options = (value: unknown) => plugin({ options: { schema: z.object({ url: z.url() }), value } });
    expect(() => assertPluginManifest(options({ url: "https://a.test" }))).not.toThrow();
    expect(() => assertPluginManifest(options({ url: "nope" }))).toThrow(/invalid option "url"/);
  });
  it("won't take a module name or origin that isn't one", () => {
    expect(() => assertPluginManifest(plugin({ admin: { server: 'a"; alert(1); "' } }))).toThrow(/module path/);
    expect(() => assertPluginManifest(plugin({ admin: { client: "@acme/tools/client" } }))).not.toThrow();
    expect(() => assertPluginManifest(plugin({ csp: { frame: ["*"] } }))).toThrow(/Content Security Policy/);
  });
});

describe("plugin migrations", () => {
  const up = () => undefined;
  const steps = (...ids: string[]) => plugin({ migrations: ids.map((id) => ({ id, up })) });
  const ids = (list: Array<{ id: string }>) => list.map(({ id }) => id);

  it("run what hasn't run yet, in order", () => {
    expect(ids(pendingMigrations(steps("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
    expect(ids(pendingMigrations(steps("a", "b", "c"), ["a"]))).toEqual(["b", "c"]);
    expect(pendingMigrations(steps("a"), ["a"])).toEqual([]);
  });
  it("don't mind an old one that was dropped from the list", () => {
    expect(ids(pendingMigrations(steps("b"), ["a"]))).toEqual(["b"]);
  });
  it("stop startup when a new one is put before one that already ran", () => {
    expect(() => pendingMigrations(steps("new", "old"), ["old"])).toThrow(/comes before "old"/);
  });
  it("need unique, plain ids", () => {
    expect(() => assertPluginManifest(steps("a", "a"))).toThrow(/listed twice/);
    expect(() => assertPluginManifest(steps("a b"))).toThrow(/invalid migration id/);
  });
  it("know a downgrade", () => {
    expect(isOlder("1.2.0", "1.10.0")).toBe(true);
    expect(isOlder("2.0.0", "1.10.0")).toBe(false);
    expect(isOlder("1.0.0", "1.0.0")).toBe(false);
  });
});

describe("plugin routes", () => {
  it("are served under the plugin's name", () => {
    expect(pluginRoutes(plugin({ routes: [route()] })).map(({ path }) => path)).toEqual(["/acme-tools/stats"]);
  });
  it("reach the root only when declared", () => {
    expect(pluginRoutes(plugin({ routes: [route({ path: "/sitemap.xml" })] })).map(({ path }) => path)).toEqual(["/acme-tools/sitemap.xml"]);
    expect(pluginRoutes(plugin({ routes: [route({ path: "/sitemap.xml", root: true })] })).map(({ path }) => path)).toEqual(["/acme-tools/sitemap.xml", "/sitemap.xml"]);
  });
  it("can only declare a single file name as a root file", () => {
    for (const path of ["/a/b.xml", "/stats", "/:file.xml"]) expect(() => assertPluginManifest(plugin({ routes: [route({ path, root: true })] })), path).toThrow(/root: true/);
  });
});

describe("import maps at run time", () => {
  const config = (extra: Partial<CmsPlugin>): CmsConfig => ({ plugins: [plugin({ admin: { server: "@acme/tools/admin" }, ...extra })] });
  it("pass when they list the running plugin", () => {
    expect(() => assertMapsMatch(config({}), { plugins: [], synced: [{ name: "acme-tools", version: "1.0.0" }] })).not.toThrow();
  });
  it("stop the page when a plugin is missing or another version", () => {
    expect(() => assertMapsMatch(config({}), { plugins: [], synced: [] })).toThrow(/tansy sync/);
    expect(() => assertMapsMatch(config({ version: "2.0.0" }), { plugins: [], synced: [{ name: "acme-tools", version: "1.0.0" }] })).toThrow(/which have 1\.0\.0/);
  });
  it("don't care about a plugin with no admin half", () => {
    expect(() => assertMapsMatch({ plugins: [plugin()] }, { plugins: [], synced: [] })).not.toThrow();
  });
});

describe("admin slots", () => {
  const hidden = "ext.acme:hidden";
  const shown = "ext.acme:read";
  const column = (id: string, permission: string, collections?: string[]) => ({ id, title: id, permission, collections, component: () => null });
  const plugins = [{ name: "on", gridColumns: [column("seen", shown), column("other", shown, ["pages"]), column("locked", hidden)] }, { name: "off", gridColumns: [column("disabled", shown)] }] as unknown as AdminClientPlugin[];

  const names = (collection?: string) => {
    let seen: string[] = [];
    function Probe() {
      seen = useAdminSlots(collection).gridColumns.map(({ id }) => id);
      return null;
    }
    renderToString(createElement(AdminClientProvider, { plugins, enabled: ["on"] }, createElement(AdminAccess, { permissions: [shown] }, createElement(Probe))));
    return seen;
  };

  it("offer only what the person's permissions and the running plugins allow", () => {
    expect(names()).toEqual(["seen", "other"]);
  });
  it("can be limited to some collections", () => {
    expect(names("posts")).toEqual(["seen"]);
    expect(names("pages")).toEqual(["seen", "other"]);
  });
  it("record which plugin each item came from, for its error boundary", () => {
    expect(flattenPlugins(plugins, ["on"]).gridColumns[0].plugin).toBe("on");
    expect(flattenPlugins(plugins, ["off"]).gridColumns.map(({ id }) => id)).toEqual(["disabled"]);
  });
  it("contain a plugin's failure, but let navigation through", () => {
    expect(PluginBoundary.getDerivedStateFromError(new Error("broken"))).toEqual({ failed: true });
    expect(() => PluginBoundary.getDerivedStateFromError(Object.assign(new Error("x"), { digest: "NEXT_REDIRECT;replace;/a;307;" }))).toThrow();
  });
  it("report a failed action instead of throwing", async () => {
    let failed = 0;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runPluginAction("acme", () => { throw new Error("no"); }, () => { failed += 1; });
    await runPluginAction("acme", () => undefined, () => { failed += 1; });
    spy.mockRestore();
    expect(failed).toBe(1);
  });
});
