import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemedPage } from "@/components/site/ThemedPage";
import { mergeRenderers, pluginRenderers } from "@/components/stream/StreamField";
import { EMPTY_LIST, loadSitePage, pageMetadata, type LoadedPage, type ResolvedAddress, type SiteReader, type SiteTheme } from "@/core/site/page";
import { assertThemeManifest } from "@/core/theme/define";
import { tokensProblem } from "@/core/theme/tokens";
import blogRenderers from "../../plugins/blog/render";
import { halo } from "../../themes/halo/index";
import haloComponents from "../../themes/halo/render";

const plugins = mergeRenderers([pluginRenderers("blog", blogRenderers)]);
const theme = (options?: Parameters<typeof halo>[0]) => ({ manifest: halo(options), components: haloComponents }) as unknown as SiteTheme;

const story = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Story ${id}`,
  excerpt: `About ${id}`,
  categories: [2],
  tags: [3],
  cover: `c${id}`,
  publishedAt: "2026-01-02T00:00:00.000Z",
  recordPath: `/blog/s${id}`,
  ...extra,
});
const list = (rows: unknown[], page = 1, totalPages = 1) => ({ page, perPage: rows.length, totalPages, totalItems: rows.length, items: rows as never[] });

const recent = Array.from({ length: 30 }, (_, index) => story(100 - index));

function lists(collection: string, options?: Record<string, unknown>) {
  const filter = typeof options?.filter === "string" ? options.filter : "";
  if (collection === "blog-categories") return list([{ id: 2, name: "Markets", recordPath: "/blog/category/markets" }]);
  if (collection === "blog-tags") return list([{ id: 3, name: "Ethereum", recordPath: "/blog/tag/ethereum" }]);
  if (collection === "blog-home") return list([{ id: 1, recordPath: "/blog" }]);
  if (collection !== "blog-posts") return EMPTY_LIST;
  if (filter === "featured = true") return list([story(7, { title: "Featured <seven>" })]);
  // Picks bound from the Front page record.
  if (filter === "id = 42") return list([story(42, { title: "Editor's lead" })]);
  if (filter === "id ?= 6 || id ?= 5") return list([story(5), story(6)]);
  if (filter.includes("id =") || filter === "0 = 1") return EMPTY_LIST;
  if (options?.page !== undefined) return list(recent.slice(0, 7), Number(options.page ?? 1), 3);
  return list(recent.slice(0, Number(options?.perPage ?? 30)));
}

function reader(pages: Record<string, ResolvedAddress>, source = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options))): SiteReader {
  return {
    resolve: async (at) => pages[at] ?? null,
    list: source as SiteReader["list"],
    get: async () => null,
    singleton: async () => null,
    branding: async () => ({ name: "Halo News", logoUrl: "" }),
    preview: async () => null,
    fileUrl: (id, thumb) => `/f/${id}${thumb ? `?thumb=${thumb}` : ""}`,
  };
}

async function render(site: SiteTheme, source: SiteReader, at: string, page?: string) {
  const loaded = await loadSitePage(site, source, at, { renderers: plugins, page });
  if (loaded.type !== "page") throw new Error(`Expected a page at ${at}, got ${loaded.type}`);
  return { page: loaded, html: renderToStaticMarkup(createElement(ThemedPage, { theme: site, page: loaded, renderers: plugins }) as never) };
}

describe("halo theme", () => {
  it("validates its own tokens and options, and needs the blog plugin", () => {
    expect(tokensProblem(halo().tokens!)).toBeNull();
    expect(() => halo({ colorScheme: "dark" as never })).toThrow();
    expect(() => assertThemeManifest(halo(), [])).toThrow(/"blog" plugin/);
    expect(() => assertThemeManifest(halo(), ["blog"])).not.toThrow();
  });

  it("fills every front page section from featured and recent posts when no Front page record exists", async () => {
    const source = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
    const { page, html } = await render(theme(), reader({}, source), "/");
    expect(page.template).toBe("home");
    // Picks need the record, so they aren't even asked for.
    expect(source).not.toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: expect.stringContaining("@record") }));
    expect(html).toContain('data-theme="halo"');
    expect(html).toContain("Featured &lt;seven&gt;");
    for (const label of ["Best of the week", "Recommended", "Latest news", "Trending now", "Readers’ choice", "Popular news"]) expect(html).toContain(label);
    expect(html).toContain('href="/blog/category/markets">Markets</a>');
    expect(html).toContain('href="/blog/tag/ethereum">#Ethereum</a>');
    expect(html).toContain('class="ha-more" href="/blog"');
    expect(html).toMatch(/src="\/f\/c\d+\?thumb=800x0"/);
    expect(html).toContain('role="search"');
    expect(html).toContain('href="/dashboard/auth/signin"');
    // The date is in the page, so a cached or script-free page is right; the browser makes it relative.
    expect(html).toContain('dateTime="2026-01-02T00:00:00.000Z"');
  });

  it("leads with the editor's picks from the Front page record, in their order", async () => {
    const front: ResolvedAddress = { type: "record", collection: "halo-front", path: "/", record: { id: 1, title: "Today", lead: 42, recommended: [6, 5], spotlight: null, trending: [], readersChoice: [], popular: [] } };
    const source = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
    const { page, html } = await render(theme(), reader({ "/": front }, source), "/");
    expect(page.template).toBe("halo-front");
    expect(source).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "id = 42", perPage: 1 }));
    expect(source).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "id ?= 6 || id ?= 5" }));
    expect(html).toContain("Editor&#x27;s lead");
    expect(html).toContain("<h1 class=\"ha-visually-hidden\">Today</h1>");
    // Recommended keeps the editor's order: 6 before 5.
    const recommended = html.slice(html.indexOf('id="ha-recommended"'));
    expect(recommended.indexOf("Story 6")).toBeGreaterThan(-1);
    expect(recommended.indexOf("Story 6")).toBeLessThan(recommended.indexOf("Story 5"));
  });

  it("keeps Recommended beside the lead filled on a small site, featured first, never the lead", async () => {
    const few = [story(4, { featured: true, title: "Lead story" }), story(3, { title: "Other featured" }), story(2), story(1)];
    const source = vi.fn(async (collection: string, options?: Record<string, unknown>) => {
      if (collection === "blog-posts" && options?.filter === "featured = true") return list([few[0], few[1]]);
      if (collection === "blog-posts") return list(few);
      return lists(collection, options);
    });
    const { html } = await render(theme(), reader({}, source), "/");
    const panel = html.slice(html.indexOf('id="ha-recommended"'), html.indexOf("ha-spotlight-wrap"));
    expect(panel).toContain("Other featured");
    expect(panel).not.toContain("Lead story");
    expect((panel.match(/class="ha-cover-link"/g) ?? []).length).toBe(3);
  });

  it("shows an empty front page plainly", async () => {
    const source = vi.fn(async () => EMPTY_LIST);
    const { html } = await render(theme(), reader({}, source as never), "/");
    expect(html).toContain("No stories yet.");
    expect(html).not.toContain("Best of the week");
  });

  it("leaves out search, account links, dates and relative times when told to", async () => {
    const { html } = await render(theme({ search: false, accountLinks: false, showDates: false, colorScheme: "light", tagline: "Markets, made readable" }), reader({}), "/");
    expect(html).not.toContain('role="search"');
    expect(html).not.toContain("/auth/signin");
    expect(html).not.toContain("dateTime=");
    expect(html).toContain("Markets, made readable");
    expect(html).toContain('data-scheme="light"');
  });

  it("pages the blog's home with arrows, seven stories a page", async () => {
    const home: ResolvedAddress = { type: "record", collection: "blog-home", path: "/blog", record: { id: 1, title: "All the news", intro: [] } };
    const source = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
    const { html } = await render(theme(), reader({ "/blog": home }, source), "/blog", "2");
    expect(source).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ perPage: 7, page: 2 }));
    expect(html).toContain("All the news");
    expect(html).toContain('rel="prev" href="/blog"');
    expect(html).toContain('rel="next" href="/blog?page=3"');
  });

  it("builds the post page from the blog plugin's parts, with recommended and related stories", async () => {
    const post: ResolvedAddress = { type: "record", collection: "blog-posts", path: "/blog/hi", record: { id: 9, title: "Hello <b>", excerpt: "Lead", tags: [3], categories: [2], cover: "big", byline: "Ada", publishedAt: "2026-01-02T00:00:00.000Z", body: [], allowComments: true } };
    const source = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
    const { page, html } = await render(theme(), reader({ "/blog/hi": post }, source), "/blog/hi");
    expect(page).toMatchObject({ template: "blog-posts", source: "theme" });
    expect(source).toHaveBeenCalledWith("blog-comments", expect.objectContaining({ filter: "post = 9" }));
    expect(source).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ filter: "tags ?= 3 && id != 9" }));
    expect(html).toContain("Hello &lt;b&gt;");
    expect(html).toContain('src="/f/big?thumb=800x0"');
    expect(html).toContain('class="bl-byline">Ada');
    expect(html).toContain('class="bl-comments"');
    expect(html).toContain("More like this");
  });

  it("names a category's page after it", async () => {
    const category: ResolvedAddress = { type: "record", collection: "blog-categories", path: "/blog/category/markets", record: { id: 2, name: "Markets", description: "Prices and people" } };
    const { page, html } = await render(theme(), reader({ "/blog/category/markets": category }), "/blog/category/markets");
    expect(html).toContain("Prices and people");
    expect(pageMetadata(theme(), page as Extract<LoadedPage, { type: "page" }>, plugins)).toMatchObject({ title: "Markets", description: "Prices and people" });
  });
});
