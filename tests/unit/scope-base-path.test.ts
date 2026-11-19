import { afterEach, describe, expect, it } from "vitest";
import { insideBasePath, isBasePath, menuWithBasePath, stripBasePath, withBasePath } from "@/core/urls/base-path";
import { currentBasePath, withScope } from "@/core/scope/context";
import { scopeSiteUrl } from "@/core/scope/provider";
import type { ScopeProvider } from "@/core/scope/provider";
import { sitePath } from "@/core/site/words";

/**
 * A scope value whose site has no address of its own is served under a path prefix on the
 * instance's, such as /acme (MULTI_TENANT_PLAN.md, "A tenant's path prefix"). The site layer
 * strips it before an address is matched and puts it back on every address it builds.
 */

describe("a scope value's path prefix", () => {
  it("is one path segment, and nothing else", () => {
    expect(isBasePath("/acme")).toBe(true);
    expect(isBasePath("/acme-2")).toBe(true);
    for (const value of ["", "/", "acme", "/acme/blog", "//acme", "/-acme", "/acme?x", "/ac me", `/${"a".repeat(65)}`, null, 7]) {
      expect(isBasePath(value), String(value)).toBe(false);
    }
  });

  it("strips the prefix from an address inside it, and leaves every other alone", () => {
    expect(stripBasePath("/acme/blog/hello", "/acme")).toBe("/blog/hello");
    // The prefix sits outside the language's, so splitLocalePath then does its own work.
    expect(stripBasePath("/acme/ar/blog/hello", "/acme")).toBe("/ar/blog/hello");
    expect(stripBasePath("/acme", "/acme")).toBe("/");
    expect(stripBasePath("/acme-corp/blog", "/acme")).toBe("/acme-corp/blog");
    expect(stripBasePath("/blog", "/acme")).toBe("/blog");
    expect(stripBasePath("/blog", "")).toBe("/blog");
    expect(insideBasePath("/blog", "")).toBe(false);
  });

  it("puts the prefix on a site address, and not on an outside one", () => {
    expect(withBasePath("/acme", "/blog/hello")).toBe("/acme/blog/hello");
    expect(withBasePath("/acme", "/")).toBe("/acme");
    expect(withBasePath("/acme", "https://fr.example.com/blog")).toBe("https://fr.example.com/blog");
    expect(withBasePath("/acme", "//evil.example")).toBe("//evil.example");
    expect(withBasePath("", "/blog")).toBe("/blog");
  });

  it("is carried by the scope state, and only with a value", () => {
    expect(currentBasePath()).toBe("");
    expect(withScope("acme", currentBasePath, "/acme")).toBe("/acme");
    expect(withScope("acme", currentBasePath)).toBe("");
    expect(() => withScope("acme", () => null, "/acme/blog")).toThrow(/base path/);
    expect(() => withScope(null, () => null, "/acme")).toThrow(/scope value/);
  });

  it("is on the addresses a client component builds with sitePath()", () => {
    const routing = { mode: "prefix" as const, prefixDefault: false, domains: {} };
    const words = { locale: "ar", messages: {}, site: { locale: "ar", defaultLocale: "en", routing, basePath: "/acme" } };
    expect(sitePath(words, "/cart")).toBe("/acme/ar/cart");
    expect(sitePath({ ...words, site: { ...words.site, basePath: undefined } }, "/cart")).toBe("/ar/cart");
    // One language, and a prefix: the prefix alone.
    expect(sitePath({ locale: "en", messages: {}, site: { locale: "en", defaultLocale: "en", routing: { mode: "none", prefixDefault: false, domains: {} }, basePath: "/acme" } }, "/cart")).toBe("/acme/cart");
  });
});

describe("menus under a path prefix", () => {
  const menu = [
    { id: "1", type: "menu_item", value: { label: "About", url: "/about", children: [{ id: "2", type: "menu_item", value: { label: "Team", url: "/about/team" } }] } },
    { id: "3", type: "menu_item", value: { label: "Shop", url: "https://shop.example.com" } },
    { id: "4", type: "menu_item", value: { label: "Home", url: "/" } },
    { id: "5", type: "menu_item", value: { label: "Typed with it", url: "/acme/news" } },
    { id: "6", type: "quote", value: { text: "/about" } },
  ];

  it("prefixes every hand-typed site path, however deep, and nothing else", () => {
    const prefixed = menuWithBasePath(menu, "/acme") as typeof menu;
    expect(prefixed[0].value.url).toBe("/acme/about");
    expect((prefixed[0].value.children as typeof menu)[0].value.url).toBe("/acme/about/team");
    expect(prefixed[1].value.url).toBe("https://shop.example.com");
    expect(prefixed[2].value.url).toBe("/acme");
    // Someone who typed the prefix meant that address, so it isn't doubled.
    expect(prefixed[3].value.url).toBe("/acme/news");
    // Another kind of block is left exactly as it was.
    expect(prefixed[4]).toEqual(menu[4]);
  });

  it("leaves a menu alone without a prefix, and anything that isn't a menu", () => {
    expect(menuWithBasePath(menu, "")).toBe(menu);
    expect(menuWithBasePath(null, "/acme")).toBe(null);
    expect(menuWithBasePath("text", "/acme")).toBe("text");
    expect(menuWithBasePath([{ id: "1", type: "menu_item", value: null }], "/acme")).toEqual([{ id: "1", type: "menu_item", value: null }]);
  });
});

/**
 * Links in emails and feeds start at `context.scope.siteUrl()`, which is where the value's
 * site begins: its own origin, or the instance's address and the value's prefix.
 */
describe("where a scope value's site begins", () => {
  const stub = (scope: Partial<ScopeProvider>): ScopeProvider => ({
    label: "Tenant",
    resolve: () => null,
    exists: () => true,
    rolesFor: () => [],
    initial: () => "acme",
    values: () => ["acme"],
    ...scope,
  });
  const globals = globalThis as { cmsConfig?: { plugins?: unknown[] } };
  const original = globals.cmsConfig;
  const originalUrl = process.env.BETTER_AUTH_URL;
  const install = (scope: Partial<ScopeProvider>) => {
    globals.cmsConfig = { plugins: [{ name: "acme-scope", version: "0.1.0", apiVersion: 1, scope: stub(scope) }] };
  };
  afterEach(() => {
    globals.cmsConfig = original;
    process.env.BETTER_AUTH_URL = originalUrl;
  });

  it("is the value's own origin when the provider names one, prefix or not", async () => {
    install({ siteUrl: () => "https://acme.example/", basePath: () => "/acme" });
    expect(await withScope("acme", () => scopeSiteUrl())).toBe("https://acme.example");
  });

  it("is the instance's address and the prefix when the value has no site of its own", async () => {
    process.env.BETTER_AUTH_URL = "https://cms.example.com/";
    install({ basePath: () => "/acme" });
    expect(await withScope("acme", () => scopeSiteUrl())).toBe("https://cms.example.com/acme");
  });

  it("is nothing without a value, a prefix or a site of the value's own", async () => {
    process.env.BETTER_AUTH_URL = "https://cms.example.com";
    install({ basePath: () => "/acme" });
    expect(await withScope(null, () => scopeSiteUrl())).toBe(null);
    install({});
    expect(await withScope("acme", () => scopeSiteUrl())).toBe(null);
    install({ siteUrl: () => "ftp://acme.example", basePath: () => null });
    expect(await withScope("acme", () => scopeSiteUrl())).toBe(null);
  });
});
