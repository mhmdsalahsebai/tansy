import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineCms, type CmsConfig } from "@/core/auth/extensions";
import { provideCmsConfig } from "@/core/config";
import { assertConfiguredExtensions } from "@/core/extend/registry";
import { defineTheme } from "@/core/theme/define";
import { defaultTheme, installedThemes, themeNamed } from "@/core/theme/installed";
import { renderMaps } from "../../packages/cms/scripts/sync.mjs";

/**
 * Several themes in one build, and a scope value choosing among them (C29, Phase 23). The config
 * side and the stored choice are here; two tenants serving their own themes over HTTP are in
 * tests/integration/multi-tenant.test.ts.
 */

const settings = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (settings.rows.has(where.key) ? { value: settings.rows.get(where.key) } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => void settings.rows.set(where.key, create.value),
    },
  },
}));

const theme = (name: string, extra: Partial<Parameters<typeof defineTheme>[0]> = {}) =>
  defineTheme({ name, version: "1.0.0", apiVersion: 1, render: `@acme/${name}/render`, ...extra });

declare const globalThis: { cmsConfig?: CmsConfig } & typeof global;
const original = globalThis.cmsConfig;
afterEach(() => { globalThis.cmsConfig = original; });

describe("the themes a build installs", () => {
  it("takes one theme from theme and several from themes, the first being the default", () => {
    expect(installedThemes({ theme: theme("solo") }).map((entry) => entry.name)).toEqual(["solo"]);
    const several = { themes: [theme("first"), theme("second")] };
    expect(installedThemes(several).map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(defaultTheme(several)?.name).toBe("first");
    expect(defaultTheme({})).toBeNull();
  });

  it("refuses a config that sets both, since neither would be the default", () => {
    expect(() => installedThemes({ theme: theme("one"), themes: [theme("two")] })).toThrow(/both theme and themes/);
  });

  it("refuses the same theme twice, which would make the choice ambiguous", () => {
    expect(() => installedThemes({ themes: [theme("twice"), theme("twice")] })).toThrow(/listed twice/);
  });

  it("falls back to the default theme for a name no longer installed, rather than serving nothing", () => {
    const config = { themes: [theme("first"), theme("second")] };
    expect(themeNamed("second", config)?.name).toBe("second");
    expect(themeNamed("gone", config)?.name).toBe("first");
    expect(themeNamed("", config)?.name).toBe("first");
    expect(themeNamed(null, config)?.name).toBe("first");
    expect(themeNamed("anything", {})).toBeNull();
  });

  it("checks every installed theme at startup, not only the default one", () => {
    provideCmsConfig(defineCms({ themes: [theme("fine"), theme("needy", { requires: { plugins: ["absent"] } })] }));
    expect(() => assertConfiguredExtensions()).toThrow(/"absent" plugin/);
    provideCmsConfig(defineCms({ themes: [theme("fine"), theme("needy", { requires: { plugins: ["absent"] } })], plugins: [{ name: "absent", version: "1.0.0", apiVersion: 1 }] }));
    expect(() => assertConfiguredExtensions()).not.toThrow();
  });
});

describe("the generated theme map", () => {
  it("exports one theme's components on their own, as a site with one theme always got", () => {
    const map = renderMaps({ theme: theme("solo") })["theme.ts"];
    expect(map).toContain('import theme from "@acme/solo/render";');
    expect(map).toContain("const components = theme as unknown as ThemeComponents;");
    expect(map).not.toContain("Record<string, ThemeComponents>");
  });

  it("exports a map by theme name where the build has several, and imports every one", () => {
    const map = renderMaps({ themes: [theme("first"), theme("second")] })["theme.ts"];
    expect(map).toContain('import theme0 from "@acme/first/render";');
    expect(map).toContain('import theme1 from "@acme/second/render";');
    expect(map).toContain("const components: Record<string, ThemeComponents> = {");
    expect(map).toContain('"first": theme0 as unknown as ThemeComponents,');
    expect(map).toContain('"second": theme1 as unknown as ThemeComponents,');
  });

  it("names every theme's package, so Next.js compiles the ones a tenant may choose too", () => {
    const manifest = JSON.parse(renderMaps({ themes: [theme("first"), theme("second")] })["manifest.json"]);
    expect(manifest.packages).toEqual(["@acme/first", "@acme/second"]);
  });

  it("shows blocks in the default theme on the editor's canvas, there being one editor", () => {
    const preview = renderMaps({ themes: [theme("first", { tokens: { color: { accent: "#123456" } } }), theme("second")] })["preview.ts"];
    expect(preview).toContain('import theme from "@acme/first/render";');
    expect(preview).not.toContain("@acme/second/render");
    expect(preview).toContain("#123456");
  });

  it("refuses a config that sets both theme and themes, before a build is written", () => {
    expect(() => renderMaps({ theme: theme("one"), themes: [theme("two")] })).toThrow(/both theme and themes/);
  });
});

describe("the theme a scope value chose", () => {
  beforeEach(() => { settings.rows.clear(); });

  it("is kept as that value's own setting, beside its name and colour", async () => {
    const { readSiteIdentity, writeSiteIdentity } = await import("@/core/site/identity");
    const { withScope } = await import("@/core/scope/context");
    await withScope("acme", () => writeSiteIdentity({ name: "Acme", logoUrl: "", accentColor: "", theme: "second", hiddenLocales: [] }, "user1"));
    await withScope("other", () => writeSiteIdentity({ name: "Other", logoUrl: "", accentColor: "", theme: "", hiddenLocales: [] }, "user1"));
    expect((await withScope("acme", () => readSiteIdentity())).theme).toBe("second");
    expect((await withScope("other", () => readSiteIdentity())).theme).toBe("");
    // Outside a value there is no own setting at all, so the instance serves its default theme.
    expect((await readSiteIdentity()).theme).toBe("");
  });

  it("keeps the rest of the identity when the stored theme is one no build has any more", async () => {
    const { readSiteIdentity, siteIdentitySchema } = await import("@/core/site/identity");
    settings.rows.set("site@acme", { name: "Acme", logoUrl: "", accentColor: "#112233", theme: "removed", hiddenLocales: [] });
    const identity = await withScopeValue("acme", readSiteIdentity);
    expect(identity.name).toBe("Acme");
    expect(identity.accentColor).toBe("#112233");
    expect(identity.theme).toBe("removed");
    // A name that was never a theme's is refused on the way in.
    expect(siteIdentitySchema.safeParse({ theme: "Not A Theme" }).success).toBe(false);
    expect(siteIdentitySchema.safeParse({ theme: "a-theme" }).success).toBe(true);
    expect(siteIdentitySchema.parse({}).theme).toBe("");
  });

  it("is read once per value and read again after a save", async () => {
    const { chosenThemeHere, writeSiteIdentity } = await import("@/core/site/identity");
    settings.rows.set("site@acme", { theme: "second" });
    expect(await withScopeValue("acme", chosenThemeHere)).toBe("second");
    await withScopeValue("acme", () => writeSiteIdentity({ name: "", logoUrl: "", accentColor: "", theme: "first", hiddenLocales: [] }, "user1"));
    expect(await withScopeValue("acme", chosenThemeHere)).toBe("first");
    expect(await chosenThemeHere()).toBe("");
  });
});

async function withScopeValue<T>(value: string, work: () => Promise<T>): Promise<T> {
  const { withScope } = await import("@/core/scope/context");
  return withScope(value, work);
}
