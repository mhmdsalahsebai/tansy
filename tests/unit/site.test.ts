import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ThemedPage } from "@/components/site/ThemedPage";
import { mergeRenderers, pluginRenderers, type Renderers } from "@/components/stream/StreamField";
import { cachedRead, invalidateSiteCache, trackCollectionRead } from "@/core/site/cache";
import { Pager } from "@/components/site/Pager";
import { parseRule } from "@/core/authz/rules/parser";
import { signPayload } from "@/core/extend/webhooks";
import { bindRecordFilter } from "@/core/site/filter";
import { EMPTY_LIST, loadSitePage, pageMetadata, pageNumber, type LoadedPage, type ResolvedAddress, type SiteReader, type SiteTheme } from "@/core/site/page";
import { themeAdditions, themeParts } from "@/core/theme/schema";
import { CmsClient, verifyWebhook } from "@/sdk";
import { createPreviewToken, verifyPreviewToken } from "@/core/site/preview";
import { assertPreviewUrl, assertThemeManifest, defineAdminTheme, defineTheme, type TemplateProps, type ThemeComponents } from "@/core/theme/define";
import { adminThemeStyles, siteTokenDeclarations, tokensProblem } from "@/core/theme/tokens";
import { blog } from "../../themes/blog/index";
import blogComponents from "../../themes/blog/render";
import blogRenderers from "../../plugins/blog/render";
import { magazine } from "../../themes/magazine/index";
import magazineComponents from "../../themes/magazine/render";
import { blank } from "../../themes/blank/index";
import blankComponents from "../../themes/blank/render";

const manifest = { name: "test", version: "1.0.0", apiVersion: 1, render: "@acme/theme/render" };

describe("theme tokens", () => {
  it("accept each group's own kind of value", () => {
    expect(tokensProblem({ color: { accent: "#2f6f5e", soft: "rgb(1 2 3 / 50%)", ink: "oklch(21% 0.016 264)" }, font: { body: 'var(--x), "Helvetica Neue", system-ui' }, space: { gap: "1.5rem" }, radius: { none: "0" }, shadow: { card: "0 1px 2px #0003" } })).toBeNull();
  });

  it.each([
    ["color", "red;}body{display:none"],
    ["color", "url(https://evil.test/x)"],
    ["color", "#12</style><script>alert(1)</script>"],
    ["font", "Arial;}*{color:red"],
    ["font", "url(x)"],
    ["space", "calc(1px)"],
    ["radius", "1px;"],
    ["shadow", "0 0 0 red;}"],
  ] as const)("refuse %s value %s", (group, value) => {
    expect(tokensProblem({ [group]: { x: value } })).toMatch(/isn't a valid/);
    expect(siteTokenDeclarations({ [group]: { x: value } })).toBe("");
  });

  it("refuse unknown groups and names that would break out of a declaration", () => {
    expect(tokensProblem({ evil: { x: "1" } } as never)).toMatch(/unknown token group/);
    expect(tokensProblem({ color: { "x:red;--y": "#fff" } })).toMatch(/token name/);
  });

  it("let the accent from Settings win, and drop an unusable one read back from the API", () => {
    expect(siteTokenDeclarations({ color: { accent: "#111111" } }, "#222222")).toBe("--site-color-accent:#111111;--site-color-accent:#222222;");
    expect(siteTokenDeclarations({ color: { accent: "#111111" } }, "red;}x{")).toBe("--site-color-accent:#111111;");
  });
});

describe("defineTheme", () => {
  it("fails where the theme is created, so a bad token fails the build", () => {
    expect(() => defineTheme({ ...manifest, tokens: { color: { a: "nope;" } } })).toThrow(/Theme "test".*valid color/);
  });

  it("refuses a wrong API version, name, render path or option", () => {
    expect(() => defineTheme({ ...manifest, apiVersion: 99 })).toThrow(/theme API 99/);
    expect(() => defineTheme({ ...manifest, name: "Bad Name" })).toThrow(/lowercase/);
    expect(() => defineTheme({ ...manifest, render: '"; import "evil' })).toThrow(/module path/);
    expect(() => defineTheme({ ...manifest, options: { schema: z.object({ a: z.number() }), value: { a: "x" } } })).toThrow(/invalid option "a"/);
  });

  it("checks required plugins at startup", () => {
    const theme = defineTheme({ ...manifest, requires: { plugins: ["seo"] } });
    expect(() => assertThemeManifest(theme, [])).toThrow(/"seo" plugin/);
    expect(() => assertThemeManifest(theme, ["seo"])).not.toThrow();
  });
});

describe("previewUrl", () => {
  it("must be a plain web address, as tokens are sent to it", () => {
    expect(() => assertPreviewUrl("https://example.com/api/preview")).not.toThrow();
    for (const bad of ["javascript:alert(1)", "/api/preview", "https://example.com/p?x=1"]) expect(() => assertPreviewUrl(bad), bad).toThrow(/previewUrl/);
  });
});

describe("admin themes", () => {
  it("write only checked tokens, including a dark set", () => {
    const css = adminThemeStyles(defineAdminTheme({ name: "corp", tokens: { light: { "color-surface": "#fafafa" }, dark: { "color-surface": "#101010" } } }).tokens);
    expect(css).toBe(":root{--cms-color-surface:#fafafa;}@media (prefers-color-scheme: dark){:root{--cms-color-surface:#101010;}}");
    expect(adminThemeStyles({ light: { "color-surface": "red;}" } })).toBeNull();
  });

  it("refuse bad tokens, and logos from another site", () => {
    expect(() => defineAdminTheme({ name: "x", tokens: { light: { surface: "#fff" } } })).toThrow(/must start with/);
    expect(() => defineAdminTheme({ name: "x", tokens: {}, logo: "https://evil.test/a.png" })).toThrow(/logo/);
    expect(() => defineAdminTheme({ name: "x", tokens: {}, logo: "//evil.test/a.png" })).toThrow(/logo/);
    expect(defineAdminTheme({ name: "x", tokens: {}, logo: "/logo.svg" }).logo).toBe("/logo.svg");
  });
});

describe("the site read cache", () => {
  it("serves repeat reads, and hands out copies", async () => {
    invalidateSiteCache();
    const load = vi.fn(async () => ({ value: 1 }));
    const first = await cachedRead(["a"], load);
    first.value = 99;
    expect(await cachedRead(["a"], load)).toEqual({ value: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("forgets everything on invalidation", async () => {
    let value = 1;
    const load = async () => value;
    expect(await cachedRead(["b"], load)).toBe(1);
    value = 2;
    invalidateSiteCache();
    expect(await cachedRead(["b"], load)).toBe(2);
  });

  it("doesn't keep a read that a write overtook", async () => {
    invalidateSiteCache();
    let finish!: (value: string) => void;
    const slow = cachedRead(["c"], () => new Promise<string>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    invalidateSiteCache();
    finish("stale");
    expect(await slow).toBe("stale");
    expect(await cachedRead(["c"], async () => "fresh")).toBe("fresh");
  });

  it("can be turned off", async () => {
    vi.stubEnv("TANSY_SITE_CACHE_SECONDS", "0");
    const load = vi.fn(async () => 1);
    await cachedRead(["d"], load);
    await cachedRead(["d"], load);
    expect(load).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  });

  /** A read registers the collections it touched, so a write can drop only what read them. */
  const reads = (key: string, collections: number[], value: () => unknown) =>
    cachedRead([key], async () => {
      for (const id of collections) trackCollectionRead(id);
      return value();
    });

  it("drops the reads that touched the collection written, and keeps the rest", async () => {
    invalidateSiteCache();
    let posts = "posts 1";
    let authors = "authors 1";
    expect(await reads("posts", [1], () => posts)).toBe("posts 1");
    expect(await reads("authors", [2], () => authors)).toBe("authors 1");
    posts = "posts 2";
    authors = "authors 2";

    invalidateSiteCache({ collection: 1 });
    expect(await reads("posts", [1], () => posts)).toBe("posts 2");
    // Nothing was written to the authors collection, so its read still stands.
    expect(await reads("authors", [2], () => authors)).toBe("authors 1");
  });

  it("drops a read that touched the collection only through a rule or an expand", async () => {
    invalidateSiteCache();
    let value = "with its author 1";
    // A read of posts that also read authors, as @collection or expand does.
    expect(await reads("posts+authors", [1, 2], () => value)).toBe("with its author 1");
    value = "with its author 2";
    invalidateSiteCache({ collection: 2 });
    expect(await reads("posts+authors", [1, 2], () => value)).toBe("with its author 2");
  });

  it("drops a read that touched nothing only when everything goes", async () => {
    invalidateSiteCache();
    let value = "branding 1";
    expect(await reads("branding", [], () => value)).toBe("branding 1");
    value = "branding 2";
    invalidateSiteCache({ collection: 1 });
    expect(await reads("branding", [], () => value)).toBe("branding 1");
    invalidateSiteCache();
    expect(await reads("branding", [], () => value)).toBe("branding 2");
  });

  it("registers in every read in progress, so a nested one can't be kept too long", async () => {
    invalidateSiteCache();
    let inner = "inner 1";
    const outer = () => cachedRead(["outer"], async () => {
      trackCollectionRead(1);
      // A read inside a read: the inner one touches another collection, and both depend on it.
      const nested = await reads("inner", [2], () => inner);
      return `outer with ${nested}`;
    });
    expect(await outer()).toBe("outer with inner 1");
    inner = "inner 2";
    invalidateSiteCache({ collection: 2 });
    expect(await outer()).toBe("outer with inner 2");
  });

  it("stops tracking a collection once its entry is gone, so the index can't grow without bound", async () => {
    invalidateSiteCache();
    await reads("gone", [7], () => "x");
    invalidateSiteCache({ collection: 7 });
    // The second write has nothing left to drop, and finds no stale key to walk.
    expect(() => invalidateSiteCache({ collection: 7 })).not.toThrow();
    expect(await reads("gone", [7], () => "y")).toBe("y");
  });
});

describe("preview tokens", () => {
  const made = createPreviewToken(1, 2, "user-1");

  it("round-trip until they expire", () => {
    expect(verifyPreviewToken(made.token)).toMatchObject({ c: 1, r: 2, u: "user-1" });
    expect(verifyPreviewToken(made.token, Date.now() + 16 * 60_000)).toBeNull();
  });

  it("refuse anything altered or missing", () => {
    const [payload, signature] = made.token.split(".");
    const other = createPreviewToken(1, 3, "user-1").token.split(".")[0];
    expect(verifyPreviewToken(`${other}.${signature}`)).toBeNull();
    expect(verifyPreviewToken(`${payload}.${"A".repeat(43)}`)).toBeNull();
    for (const bad of [undefined, null, "", "x", `${payload}.`, `.${signature}`]) expect(verifyPreviewToken(bad)).toBeNull();
  });
});

function reader(pages: Record<string, ResolvedAddress>, extra: Partial<SiteReader> = {}): SiteReader {
  return {
    resolve: async (path) => pages[path] ?? null,
    list: async () => EMPTY_LIST,
    get: async () => null,
    singleton: async () => null,
    branding: async () => ({ name: "Site", logoUrl: "" }),
    preview: async () => null,
    fileUrl: (id) => `/f/${id}`,
    ...extra,
  };
}

const Default = ({ record }: TemplateProps) => createElement("b", null, String(record?.title));
const theme: SiteTheme = { manifest, components: { templates: { default: Default } } };
const live: ResolvedAddress = { type: "record", collection: "pages", path: "/a", record: { id: 1, title: "Live" } };

describe("loadSitePage", () => {
  it("returns redirects and missing pages as values", async () => {
    const to: ResolvedAddress = { type: "redirect", to: "/b", status: 301 };
    expect(await loadSitePage(theme, reader({ "/old": to }), "/old")).toEqual(to);
    expect(await loadSitePage(theme, reader({}), "/nope")).toEqual({ type: "missing" });
    expect(await loadSitePage(theme, reader({}), "//evil.test")).toEqual({ type: "missing" });
  });

  it("needs a home template for a root with no record", async () => {
    expect(await loadSitePage(theme, reader({}), "/")).toEqual({ type: "missing" });
    const withHome: SiteTheme = { manifest, components: { templates: { home: Default } } };
    expect(await loadSitePage(withHome, reader({}), "/")).toMatchObject({ type: "page", template: "home" });
  });

  it("isn't fooled by a collection named after an Object member", async () => {
    const odd: ResolvedAddress = { type: "record", collection: "constructor", path: "/a", record: { id: 1 } };
    expect(await loadSitePage(theme, reader({ "/a": odd }), "/a")).toMatchObject({ template: "default" });
  });

  it("applies a preview only at the address of the record it names", async () => {
    const preview = vi.fn(async () => ({ collection: "pages", path: "/a", record: { id: 1, title: "Draft" } }));
    const site = reader({ "/a": live, "/other": { ...live, path: "/other", record: { id: 2, title: "Other" } } }, { preview });
    expect(await loadSitePage(theme, site, "/a", { previewToken: "t" })).toMatchObject({ props: { preview: true, record: { title: "Draft" } } });
    expect(await loadSitePage(theme, site, "/other", { previewToken: "t" })).toMatchObject({ props: { preview: false, record: { title: "Other" } } });
    expect(await loadSitePage(theme, site, "/a")).toMatchObject({ props: { preview: false, record: { title: "Live" } } });
  });

  it("ignores a token the reader refuses", async () => {
    expect(await loadSitePage(theme, reader({ "/a": live }), "/a", { previewToken: "bad" })).toMatchObject({ props: { preview: false, record: { title: "Live" } } });
  });

  describe("members' pages", () => {
    const gated: ResolvedAddress = { type: "record", collection: "pages", path: "/members", record: { id: 7, title: "Members only" } };
    const memberList = { ...EMPTY_LIST, totalItems: 1, items: [{ id: 3, title: "Mine" }] };
    const member = (pages: Record<string, ResolvedAddress>) => reader(pages, { list: vi.fn(async () => memberList), get: vi.fn(async () => ({ id: 7, title: "Expanded as member" })) });
    const withQueries = (queries: Record<string, { collection: string; viewer?: boolean; expand?: string }>, expand?: string): SiteTheme => ({ manifest: { ...manifest, queries: { default: queries }, ...(expand ? { expand: { pages: expand } } : {}) }, components: { templates: { default: Default } } });

    it("never asks who is looking for a visitor's page", async () => {
      const viewer = vi.fn(async () => member({}));
      const site = reader({ "/a": live }, { viewer });
      expect(await loadSitePage(withQueries({ all: { collection: "posts" } }), site, "/a")).toMatchObject({ type: "page" });
      expect(viewer).not.toHaveBeenCalled();
    });

    it("show a record only the signed-in member may view, and read everything about it as them", async () => {
      const asMember = member({ "/members": gated });
      const viewer = vi.fn(async () => asMember);
      const page = await loadSitePage(withQueries({ mine: { collection: "progress", viewer: true } }, "author"), reader({}, { viewer }), "/members");
      expect(page).toMatchObject({ type: "page", props: { record: { title: "Expanded as member" }, data: { mine: { items: [{ title: "Mine" }] } } } });
      expect(viewer).toHaveBeenCalledTimes(1);
      expect(asMember.get).toHaveBeenCalledWith("pages", 7, { expand: "author" });
    });

    it("stay missing when nobody is signed in, or the reader can't tell", async () => {
      expect(await loadSitePage(theme, reader({}, { viewer: async () => null }), "/members")).toEqual({ type: "missing" });
      expect(await loadSitePage(theme, reader({}), "/members")).toEqual({ type: "missing" });
    });

    it("run only `viewer` queries as the member, without passing the flag on", async () => {
      const asMember = member({});
      const visitorList = vi.fn(async () => EMPTY_LIST);
      const page = await loadSitePage(withQueries({ all: { collection: "posts" }, mine: { collection: "progress", viewer: true } }), reader({ "/a": live }, { list: visitorList, viewer: async () => asMember }), "/a") as Extract<LoadedPage, { type: "page" }>;
      expect(page.props.data.mine.items).toHaveLength(1);
      expect(page.props.data.all.items).toHaveLength(0);
      expect(asMember.list).toHaveBeenCalledWith("progress", {});
      expect(visitorList).toHaveBeenCalledWith("posts", {});
    });

    it("run `viewer` queries as a visitor when nobody is signed in", async () => {
      const visitorList = vi.fn(async () => EMPTY_LIST);
      await loadSitePage(withQueries({ mine: { collection: "progress", viewer: true } }), reader({ "/a": live }, { list: visitorList, viewer: async () => null }), "/a");
      expect(visitorList).toHaveBeenCalledWith("progress", {});
    });
  });

  it("takes the title and description from the record", async () => {
    const seo: ResolvedAddress = { ...live, record: { id: 1, title: "T", seo_title: "S", summary: "Sum" } } as ResolvedAddress;
    const page = await loadSitePage(theme, reader({ "/a": seo }), "/a") as Extract<LoadedPage, { type: "page" }>;
    expect(pageMetadata(theme, page)).toEqual({ title: "S", description: "Sum" });
  });
});

const render = async (site: SiteTheme, source: SiteReader, path: string, renderers?: Renderers) => {
  const page = await loadSitePage(site, source, path, { renderers });
  if (page.type !== "page") throw new Error(`Expected a page at ${path}, got ${page.type}`);
  return renderToStaticMarkup(createElement(ThemedPage, { theme: site, page, renderers }) as never);
};

describe("first-party themes", () => {
  const block = (id: string, type: string, value: Record<string, unknown>) => ({ id, type, v: 1, value });
  const post: ResolvedAddress = { type: "record", collection: "blog-posts", path: "/blog/hi", record: { id: 7, slug: "hi", title: "Hello <b>", publishedAt: "2026-01-02T00:00:00.000Z", body: [block("q", "blog_quote", { text: "Stay", source: "Me" }), block("x", "gone", {})] } };
  const blogPlugin = pluginRenderers("blog", blogRenderers);
  const blogTheme = { manifest: blog({ tagline: "Notes" }), components: blogComponents } as unknown as SiteTheme;

  it("blog validates its own tokens and options", () => {
    expect(() => blog()).not.toThrow();
    expect(tokensProblem(blog().tokens!)).toBeNull();
  });

  it("blog needs the blog plugin, and renders posts with its own template made of the plugin's parts", async () => {
    expect(() => assertThemeManifest(blog(), [])).toThrow(/"blog" plugin/);
    const list = vi.fn(async (collection: string) => (collection === "blog-tags" ? { ...EMPTY_LIST, items: [{ id: 3, name: "Notes", recordPath: "/blog/tag/notes" }] } : EMPTY_LIST));
    const tagged: ResolvedAddress = { ...post, record: { ...post.record, tags: [3] } } as ResolvedAddress;
    const page = await loadSitePage(blogTheme, reader({ "/blog/hi": tagged }, { list }), "/blog/hi", { renderers: blogPlugin });
    expect(page).toMatchObject({ template: "blog-posts", source: "theme" });
    // The plugin's lists, which its parts read, reach the theme's template.
    expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "tags ?= 3 && id != 7", perPage: 3 }));
    expect(list).toHaveBeenCalledWith("blog-comments", expect.objectContaining({ filter: "post = 7" }));
    const html = renderToStaticMarkup(createElement(ThemedPage, { theme: blogTheme, page: page as Extract<LoadedPage, { type: "page" }>, renderers: blogPlugin }) as never);
    expect(html).toContain('class="blog-main"');
    expect(html).toContain('href="/blog/tag/notes"');
    expect(html).toContain('class="bl-comments"');
    expect(html).toContain('class="blog-shell"');
    expect(html).toContain("Hello &lt;b&gt;");
    expect(html).toContain("<cite>Me</cite>");
    expect(html).toContain("Notes");
    expect(html).toContain('data-missing-block="gone"');
    expect(html).toContain("--site-color-accent:#2f6f5e");
    expect(html).toContain("January 2, 2026");
  });

  it("blog lists posts on its home page", async () => {
    const list = vi.fn(async () => ({ ...EMPTY_LIST, items: [{ id: 1, title: "First", recordPath: "/blog/a%20b" }] }));
    const html = await render(blogTheme, reader({}, { list }), "/");
    expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ sort: "-publishedAt", perPage: 20, urls: "1" }));
    expect(html).toContain('href="/blog/a%20b"');
  });

  it("blog hides dates on its post page when told to", async () => {
    const quiet = { manifest: blog({ showDates: false }), components: blogComponents } as unknown as SiteTheme;
    expect(await render(quiet, reader({ "/blog/hi": post }), "/blog/hi", blogPlugin)).not.toContain("January 2, 2026");
  });

  it("blog pages its home page", async () => {
    const list = vi.fn(async () => ({ page: 2, perPage: 20, totalItems: 45, totalPages: 3, items: [{ id: 1, title: "Older" }] }));
    const page = await loadSitePage(blogTheme, reader({}, { list }), "/", { page: "2" });
    expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ page: 2 }));
    const html = renderToStaticMarkup(createElement(ThemedPage, { theme: blogTheme, page: page as Extract<LoadedPage, { type: "page" }> }) as never);
    expect(html).toContain('<a rel="prev" href="/">Newer posts</a>');
    expect(html).toContain('<a rel="next" href="/?page=3">Older posts</a>');
  });

  describe("magazine", () => {
    const magazineTheme = (options?: Parameters<typeof magazine>[0]) => ({ manifest: magazine(options), components: magazineComponents }) as unknown as SiteTheme;
    const categories = { ...EMPTY_LIST, items: [{ id: 2, name: "Frontend", recordPath: "/blog/category/frontend" }] };
    const card = { id: 4, title: "Designing <fast>", excerpt: "Short", cover: "abc", categories: [2], readingMinutes: 3, publishedAt: "2026-01-02T00:00:00.000Z", recordPath: "/blog/speed" };
    const lists = (collection: string, options?: Record<string, unknown>) => {
      if (collection === "blog-categories") return categories;
      if (collection === "blog-posts" && options?.fields === "id,title,publishedAt,cover") return { ...EMPTY_LIST, items: [{ id: 9, title: "In the sidebar", cover: "side", recordPath: "/blog/side" }] };
      if (collection === "blog-posts") return { ...EMPTY_LIST, page: 1, totalPages: 1, items: [card] };
      return EMPTY_LIST;
    };

    it("validates its own tokens and options, and needs the blog plugin", () => {
      expect(tokensProblem(magazine().tokens!)).toBeNull();
      expect(() => magazine({ colorScheme: "dark" as never })).toThrow();
      expect(() => assertThemeManifest(magazine(), [])).toThrow(/"blog" plugin/);
      expect(() => assertThemeManifest(magazine(), ["blog"])).not.toThrow();
    });

    it("shows posts as cards with covers and category links, beside featured and latest posts", async () => {
      const list = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
      const html = await render(magazineTheme(), reader({}, { list }), "/", blogPlugin);
      expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ perPage: 9, sort: "-publishedAt", fields: expect.stringContaining("cover"), urls: "1" }));
      expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "featured = true", perPage: 3 }));
      expect(html).toContain('data-theme="magazine"');
      expect(html).toContain('class="mg-card-link" href="/blog/speed"');
      expect(html).toContain("Designing &lt;fast&gt;");
      expect(html).toContain('href="/blog/category/frontend">Frontend</a>');
      expect(html).toContain('src="/f/abc"');
      expect(html).toContain("In the sidebar");
      expect(html).toContain("3 min read");
      expect(html).toContain('role="search"');
      expect(html).toContain('href="/dashboard/auth/signin"');
      expect(html).toContain('data-scheme="auto"');
    });

    it("leaves out search, account links and dates when told to", async () => {
      const list = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
      const html = await render(magazineTheme({ search: false, accountLinks: false, showDates: false, colorScheme: "light", tagline: "Our notes" }), reader({}, { list }), "/", blogPlugin);
      expect(html).not.toContain('role="search"');
      expect(html).not.toContain("/auth/signin");
      expect(html).not.toContain("January 2, 2026");
      expect(html).not.toContain("Jan 2, 2026");
      expect(html).toContain("Our notes");
      expect(html).toContain('data-scheme="light"');
    });

    it("builds the post page from the blog plugin's parts, with its own cards under it", async () => {
      const list = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
      const tagged = { ...post, record: { ...post.record, tags: [3], categories: [2], cover: "big" } } as ResolvedAddress;
      const page = await loadSitePage(magazineTheme(), reader({ "/blog/hi": tagged }, { list }), "/blog/hi", { renderers: blogPlugin });
      expect(page).toMatchObject({ template: "blog-posts", source: "theme" });
      expect(list).toHaveBeenCalledWith("blog-comments", expect.objectContaining({ filter: "post = 7" }));
      expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "tags ?= 3 && id != 7", fields: expect.stringContaining("cover") }));
      const html = renderToStaticMarkup(createElement(ThemedPage, { theme: magazineTheme(), page: page as Extract<LoadedPage, { type: "page" }>, renderers: blogPlugin }) as never);
      expect(html).toContain("Hello &lt;b&gt;");
      expect(html).toContain('src="/f/big"');
      expect(html).toContain('class="bl-comments"');
      expect(html).toContain("<cite>Me</cite>");
      expect(html).toContain("Keep reading");
      expect(html).toContain('href="/blog/speed"');
    });

    it("lists a category's posts with covers, in place of the plugin's list", async () => {
      const list = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
      const category: ResolvedAddress = { type: "record", collection: "blog-categories", path: "/blog/category/frontend", record: { id: 2, name: "Frontend", description: "Pixels" } };
      const page = await loadSitePage(magazineTheme(), reader({ "/blog/category/frontend": category }, { list }), "/blog/category/frontend", { renderers: blogPlugin });
      expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "categories ?= 2", page: 1, fields: expect.stringContaining("cover") }));
      expect(pageMetadata(magazineTheme(), page as Extract<LoadedPage, { type: "page" }>, blogPlugin)).toMatchObject({ title: "Frontend", description: "Pixels" });
    });
  });

  it("blank renders any record with no setup", async () => {
    const page: ResolvedAddress = { type: "record", collection: "pages", path: "/a", record: { id: 1, title: "Hello", intro: "Words", status: "published" } };
    const html = await render({ manifest: blank(), components: blankComponents as ThemeComponents }, reader({ "/a": page }), "/a");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>Words</p>");
    expect(html).not.toContain("published");
  });

  it("show the preview notice only on a preview", async () => {
    const site = reader({ "/a": live }, { preview: async () => ({ collection: "pages", path: "/a", record: { id: 1, title: "D" } }) });
    const page = await loadSitePage(theme, site, "/a", { previewToken: "t" }) as Extract<LoadedPage, { type: "page" }>;
    expect(renderToStaticMarkup(createElement(ThemedPage, { theme, page, exitPreviewHref: "/x" }) as never)).toContain('href="/x"');
    expect(await render(theme, site, "/a")).not.toContain("data-preview-notice");
  });
});

describe("plugin templates", () => {
  const Post = ({ record, data }: TemplateProps) => createElement("article", null, `post ${String(record?.title)} (${data.recent?.items.length ?? 0} recent)`);
  const plugin: Renderers = pluginRenderers("blog", { templates: { "blog-posts": Post }, queries: { "blog-posts": { recent: { collection: "blog-posts", perPage: 3 } } }, expand: { "blog-posts": "author" } });
  const post: ResolvedAddress = { type: "record", collection: "blog-posts", path: "/blog/hi", record: { id: 7, title: "Hi" } };
  const Layout = ({ children }: { children: unknown }) => createElement("main", { "data-layout": "theme" }, children as never);
  const site: SiteTheme = { manifest, components: { templates: { default: Default }, layouts: { default: Layout as never } } };

  it("render a plugin's collection inside the theme's layout, with the plugin's queries and expand", async () => {
    const list = vi.fn(async () => ({ ...EMPTY_LIST, items: [{ id: 1 }, { id: 2 }] }));
    const get = vi.fn(async () => ({ id: 7, title: "Hi, expanded" }));
    const source = reader({ "/blog/hi": post }, { list, get });
    const page = await loadSitePage(site, source, "/blog/hi", { renderers: plugin });
    expect(page).toMatchObject({ type: "page", template: "blog-posts", source: "plugin" });
    expect(list).toHaveBeenCalledWith("blog-posts", { perPage: 3 });
    expect(get).toHaveBeenCalledWith("blog-posts", 7, { expand: "author" });
    const html = renderToStaticMarkup(createElement(ThemedPage, { theme: site, page: page as Extract<LoadedPage, { type: "page" }>, renderers: plugin }) as never);
    expect(html).toContain('<main data-layout="theme"><article>post Hi, expanded (2 recent)</article></main>');
  });

  it("give way to the theme's own template for that collection", async () => {
    const themed: SiteTheme = { manifest, components: { templates: { "blog-posts": Default, default: Default } } };
    expect(await loadSitePage(themed, reader({ "/blog/hi": post }), "/blog/hi", { renderers: plugin })).toMatchObject({ template: "blog-posts", source: "theme" });
  });

  it("aren't used without renderers, so the theme's default renders as before", async () => {
    expect(await loadSitePage(site, reader({ "/blog/hi": post }), "/blog/hi")).toMatchObject({ template: "default", source: "theme" });
  });

  it("refuse to render when ThemedPage didn't get the renderers the page was loaded with", async () => {
    const page = await loadSitePage(site, reader({ "/blog/hi": post }), "/blog/hi", { renderers: plugin }) as Extract<LoadedPage, { type: "page" }>;
    expect(() => renderToStaticMarkup(createElement(ThemedPage, { theme: site, page }) as never)).toThrow(/Pass the same renderers/);
  });

  it("are only for the plugin's own collections", () => {
    expect(() => pluginRenderers("blog", { templates: { "shop-products": Post } })).toThrow(/Plugin "blog": templates names "shop-products"/);
    expect(() => pluginRenderers("blog", { queries: { pages: {} } })).toThrow(/queries names "pages"/);
    expect(() => pluginRenderers("blog", { expand: { blog: "x" } })).toThrow(/expand names "blog"/);
  });

  it("can name the page's record in a filter, and return nothing on a page without one", async () => {
    const list = vi.fn(async () => EMPTY_LIST);
    const archive: SiteTheme = { manifest: { ...manifest, queries: { "blog-tags": { posts: { collection: "blog-posts", filter: "tags ?= @record.id && featured = true", perPage: 5 } }, home: { posts: { collection: "blog-posts", filter: "tags ?= @record.id" } } } }, components: { templates: { "blog-tags": Default, home: Default } } };
    const tag: ResolvedAddress = { type: "record", collection: "blog-tags", path: "/blog/tag/a", record: { id: 12, name: "A" } };
    await loadSitePage(archive, reader({ "/blog/tag/a": tag }, { list }), "/blog/tag/a");
    expect(list).toHaveBeenCalledWith("blog-posts", { filter: "tags ?= 12 && featured = true", perPage: 5 });
    list.mockClear();
    expect(await loadSitePage(archive, reader({}, { list }), "/")).toMatchObject({ type: "page", props: { data: { posts: EMPTY_LIST } } });
    expect(list).not.toHaveBeenCalled();
  });

  it("lend their lists to the theme's template for that collection, and the theme's own lists win on a name", async () => {
    const list = vi.fn(async () => EMPTY_LIST);
    const themed: SiteTheme = { manifest: { ...manifest, queries: { "blog-posts": { recent: { collection: "blog-posts", perPage: 9 }, mine: { collection: "pages" } } } }, components: { templates: { "blog-posts": Default } } };
    await loadSitePage(themed, reader({ "/blog/hi": post }, { list }), "/blog/hi", { renderers: plugin });
    expect(list.mock.calls).toEqual([["blog-posts", { perPage: 9 }], ["pages", {}]]);
  });

  it("can't be claimed twice", () => {
    expect(() => mergeRenderers([plugin, { templates: { "blog-posts": Post } }])).toThrow(/Two plugins render "blog-posts"/);
  });
});

describe("plugins' components on every page", () => {
  const Part = ({ page, props }: { page: { path: string; recordId: number | null; preview: boolean }; props: Record<string, unknown> }) => createElement("i", { "data-part": `${page.path}#${page.recordId}:${String(props.note)}` });
  const plugin: Renderers = pluginRenderers("tracker", { everyPage: { "tracker-beacon": Part as never } });

  it("render after the layout with the props the reader gave for this page", async () => {
    const everyPage = vi.fn(async () => ({ "tracker-beacon": { note: "hi" } }));
    const page = await loadSitePage(theme, reader({ "/a": live }, { everyPage }), "/a", { renderers: plugin }) as Extract<LoadedPage, { type: "page" }>;
    expect(everyPage).toHaveBeenCalledWith({ path: "/a", collection: "pages", recordId: 1, locale: null, preview: false });
    const html = renderToStaticMarkup(createElement(ThemedPage, { theme, page, renderers: plugin }) as never);
    expect(html).toContain('<b>Live</b><i data-part="/a#1:hi"></i>');
  });

  it("are left off a page the reader gave no props for, and without renderers", async () => {
    const none = await loadSitePage(theme, reader({ "/a": live }, { everyPage: async () => ({}) }), "/a", { renderers: plugin }) as Extract<LoadedPage, { type: "page" }>;
    expect(none.everyPage).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ThemedPage, { theme, page: none, renderers: plugin }) as never)).not.toContain("data-part");
    const given = await loadSitePage(theme, reader({ "/a": live }, { everyPage: async () => ({ "tracker-beacon": {}, "other-thing": {} }) }), "/a") as Extract<LoadedPage, { type: "page" }>;
    expect(renderToStaticMarkup(createElement(ThemedPage, { theme, page: given }) as never)).not.toContain("data-part");
  });

  it("tell the plugin when the page is a preview", async () => {
    const everyPage = vi.fn(async () => ({}));
    const preview = async () => ({ collection: "pages", path: "/a", record: { id: 1, title: "Draft" } });
    await loadSitePage(theme, reader({ "/a": live }, { everyPage, preview }), "/a", { previewToken: "t" });
    expect(everyPage).toHaveBeenCalledWith(expect.objectContaining({ preview: true }));
  });

  it("are only the plugin's own, and can't be claimed twice", () => {
    expect(() => pluginRenderers("tracker", { everyPage: { "cookie-banner": Part as never } })).toThrow(/Plugin "tracker": everyPage names "cookie-banner"/);
    expect(() => mergeRenderers([plugin, { everyPage: { "tracker-beacon": Part as never } }])).toThrow(/Two plugins render "tracker-beacon"/);
  });
});

describe("paged queries", () => {
  const paged: SiteTheme = { manifest: { ...manifest, queries: { home: { posts: { collection: "posts", perPage: 10, paged: true }, latest: { collection: "posts", perPage: 3 } } } }, components: { templates: { home: Default } } };
  const pages = (totalPages: number) => vi.fn(async (_: string, options?: Record<string, unknown>) => ({ ...EMPTY_LIST, page: Number(options?.page ?? 1), totalPages }));

  it("read the page the address asks for, and leave other lists alone", async () => {
    const list = pages(3);
    await loadSitePage(paged, reader({}, { list }), "/", { page: "2" });
    expect(list).toHaveBeenCalledWith("posts", { perPage: 10, page: 2 });
    expect(list).toHaveBeenCalledWith("posts", { perPage: 3 });
  });

  it("show the not-found page past the last page, but an empty first page is a page", async () => {
    expect(await loadSitePage(paged, reader({}, { list: pages(3) }), "/", { page: 4 })).toEqual({ type: "missing" });
    expect(await loadSitePage(paged, reader({}, { list: pages(0) }), "/")).toMatchObject({ type: "page" });
  });

  it("read anything that isn't a plain page number as the first page", () => {
    for (const value of [undefined, null, "", "0", "-1", "1.5", "2e3", " 2", "abc", ["x", "2"]]) expect(pageNumber(value as never)).toBe(1);
    expect(pageNumber(["3", "4"])).toBe(3);
    expect(pageNumber("99999")).toBe(10_000);
  });

  it("render previous and next links only where there's a page to go to", () => {
    const html = (page: number, totalPages: number) => renderToStaticMarkup(createElement(Pager, { list: { ...EMPTY_LIST, page, totalPages }, path: "/blog/caf%C3%A9" }));
    expect(html(1, 1)).toBe("");
    expect(html(1, 2)).toContain('href="/blog/caf%C3%A9?page=2"');
    expect(html(1, 2)).not.toContain('rel="prev"');
    expect(html(2, 2)).toContain('<a rel="prev" href="/blog/caf%C3%A9">');
    expect(html(2, 2)).not.toContain('rel="next"');
  });
});

describe("@record in template filters", () => {
  const post = { id: 7, title: 'Say "hi" \\ bye', tags: [3, 4], none: [], score: 2.5, flag: true, gone: null, nested: { a: 1 } };

  it("write values in as literals of the rule syntax", () => {
    expect(bindRecordFilter("id != @record.id && title = @record.title", post)).toBe('id != 7 && title = "Say \\"hi\\" \\\\ bye"');
    expect(bindRecordFilter("score >= @record.score || flag = @record.flag || x = @record.gone", post)).toBe("score >= 2.5 || flag = true || x = null");
  });

  it("match any value of a list, as an OR that keeps its place among ANDs", () => {
    expect(bindRecordFilter("tags ?= @record.tags && id != @record.id", post)).toBe("(tags ?= 3 || tags ?= 4) && id != 7");
    expect(bindRecordFilter("@record.tags ?= tags", post)).toBe("3 ?= tags || 4 ?= tags");
    expect(bindRecordFilter("tags ?= @record.none && featured = true", post)).toBe("0 = 1 && featured = true");
  });

  it("refuse what can't be written in, which the template gets as an empty list", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const filter of ["tags = @record.tags", "x = @record.nested", "x = @record.missing", "x = @record.tags.first", "x = @record.id:length", "@record.tags ?= @record.tags"]) {
      expect(bindRecordFilter(filter, post)).toBeNull();
    }
    expect(bindRecordFilter("x = @record.id", { id: 1e21 })).toBeNull();
    warn.mockRestore();
  });

  it("leave other filters as written, and need a record for one that names it", () => {
    expect(bindRecordFilter('title = "@record.id"', null)).toBe('title = "@record.id"');
    expect(bindRecordFilter("published = true", null)).toBe("published = true");
    expect(bindRecordFilter("tags ?= @record.id", null)).toBeNull();
  });

  it("produce filters the API parses back to the same values", () => {
    const tree = parseRule(bindRecordFilter("title = @record.title", post)!);
    expect(tree).toMatchObject({ right: { kind: "literal", value: post.title } });
  });
});

describe("theme schema upgrades", () => {
  const field = (name: string) => ({ name, type: "text", config: {} });
  const collection = (slug: string, names: string[]) => ({ slug, name: slug, description: null, type: "base" as const, viewQuery: null, urlPattern: null, rules: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null }, fields: names.map(field) });
  const block = (name: string) => ({ name, label: name, icon: null, version: 1, fields: [] });
  const theme = { version: 1 as const, collections: [collection("posts", ["title", "subtitle"]), collection("pages", ["title"])], blocks: [block("hero"), block("quote")] };

  it("create everything on a fresh database", () => {
    expect(themeAdditions(theme, { version: 1, collections: [], blocks: [] }, new Set())).toEqual(theme);
  });

  it("add a new version's fields to a collection that exists, keeping its owner's details", () => {
    const owned = { ...collection("posts", ["title", "extra"]), name: "Articles", urlPattern: "/a/{slug}" };
    const seen = new Set(themeParts({ ...theme, collections: [collection("posts", ["title"]), collection("pages", ["title"])] }));
    const added = themeAdditions(theme, { version: 1, collections: [owned, collection("pages", ["title"])], blocks: [block("hero"), block("quote")] }, seen);
    expect(added.collections).toEqual([{ ...owned, fields: [field("title"), field("extra"), field("subtitle")] }]);
    expect(added.blocks).toEqual([]);
  });

  it("never bring back what the owner removed", () => {
    const seen = new Set(themeParts(theme));
    expect(themeAdditions(theme, { version: 1, collections: [collection("posts", ["title"])], blocks: [] }, seen)).toEqual({ version: 1, collections: [], blocks: [] });
  });

  it("leave a collection of another type alone", () => {
    const singleton = { ...collection("pages", []), type: "singleton" as const };
    expect(themeAdditions({ ...theme, blocks: [] }, { version: 1, collections: [collection("posts", ["title", "subtitle"]), singleton], blocks: [] }, new Set()).collections).toEqual([]);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ event: "record.update" });
  const now = 1_800_000_000_000;
  const signed = (secret: string, at = now, payload = body) => `t=${at / 1000},v1=${signPayload(secret, String(at / 1000), payload)}`;

  it("accept what the CMS signs", async () => {
    expect(await verifyWebhook("s3cret", signed("s3cret"), body, { now })).toBe(true);
  });

  it("refuse another secret, a changed body, an old delivery and a malformed header", async () => {
    expect(await verifyWebhook("other", signed("s3cret"), body, { now })).toBe(false);
    expect(await verifyWebhook("s3cret", signed("s3cret"), `${body} `, { now })).toBe(false);
    expect(await verifyWebhook("s3cret", signed("s3cret", now - 600_000), body, { now })).toBe(false);
    expect(await verifyWebhook("s3cret", "v1=abc", body, { now })).toBe(false);
    expect(await verifyWebhook("s3cret", null, body, { now })).toBe(false);
    expect(await verifyWebhook("", signed(""), body, { now })).toBe(false);
  });
});

describe("the headless reader", () => {
  it("passes cache tags to fetch for reads, but never for a preview", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ page: 1, perPage: 0, totalItems: 0, totalPages: 0, items: [] }));
    const site = new CmsClient({ url: "https://cms.test", fetch: fetch as never }).reader({ tags: ["cms"], revalidate: 60 });
    await site.list("posts", { perPage: 1 });
    expect(fetch).toHaveBeenLastCalledWith("https://cms.test/api/collections/posts/records?perPage=1", expect.objectContaining({ next: { tags: ["cms"], revalidate: 60 } }));
    await site.preview("t");
    expect(fetch.mock.calls.at(-1)?.[1]).not.toHaveProperty("next");
  });
});
