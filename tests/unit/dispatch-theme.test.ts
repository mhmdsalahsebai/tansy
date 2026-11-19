import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemedPage } from "@/components/site/ThemedPage";
import { mergeRenderers, pluginRenderers } from "@/components/stream/StreamField";
import { EMPTY_LIST, loadSitePage, type ResolvedAddress, type SiteReader, type SiteTheme } from "@/core/site/page";
import { assertThemeManifest } from "@/core/theme/define";
import { tokensProblem } from "@/core/theme/tokens";
import blogRenderers from "../../plugins/blog/render";
import newsletterRenderers from "../../plugins/newsletter/render";
import { dispatch } from "../../themes/dispatch/index";
import dispatchComponents from "../../themes/dispatch/render";

const plugins = mergeRenderers([pluginRenderers("blog", blogRenderers), pluginRenderers("newsletter", newsletterRenderers)]);
const theme = (options?: Parameters<typeof dispatch>[0]) => ({ manifest: dispatch(options), components: dispatchComponents }) as unknown as SiteTheme;

const issue = (id: number, title: string) => ({ id, title, excerpt: `About ${title}`, readingMinutes: 4, publishedAt: "2026-01-02T00:00:00.000Z", recordPath: `/blog/${id}` });

function lists(collection: string, options?: Record<string, unknown>) {
  if (collection === "newsletter-page") return { ...EMPTY_LIST, items: [{ id: 1, recordPath: "/letters" }] };
  if (collection === "blog-posts" && options?.page === 2) return { page: 2, perPage: 12, totalPages: 2, totalItems: 14, items: [issue(2, "Second"), issue(1, "First")] };
  if (collection === "blog-posts") return { page: 1, perPage: 12, totalPages: 2, totalItems: 14, items: [issue(14, "Fourteenth <edition>"), issue(13, "Thirteenth")] };
  return EMPTY_LIST;
}

function reader(pages: Record<string, ResolvedAddress>, list = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options))): SiteReader {
  return {
    resolve: async (at) => pages[at] ?? null,
    list,
    get: async () => null,
    singleton: async () => null,
    branding: async () => ({ name: "The Weekly", logoUrl: "" }),
    preview: async () => null,
    fileUrl: (id, thumb) => `/f/${id}${thumb ? `?thumb=${thumb}` : ""}`,
  };
}

async function render(site: SiteTheme, source: SiteReader, at: string, page?: string) {
  const loaded = await loadSitePage(site, source, at, { renderers: plugins, page });
  if (loaded.type !== "page") throw new Error(`Expected a page at ${at}, got ${loaded.type}`);
  return { page: loaded, html: renderToStaticMarkup(createElement(ThemedPage, { theme: site, page: loaded, renderers: plugins }) as never) };
}

describe("dispatch theme", () => {
  it("validates its own tokens and options, and needs the newsletter and blog plugins", () => {
    expect(tokensProblem(dispatch().tokens!)).toBeNull();
    expect(() => dispatch({ colorScheme: "dark" as never })).toThrow();
    expect(() => assertThemeManifest(dispatch(), ["blog"])).toThrow(/"newsletter" plugin/);
    expect(() => assertThemeManifest(dispatch(), ["newsletter"])).toThrow(/"blog" plugin/);
    expect(() => assertThemeManifest(dispatch(), ["newsletter", "blog"])).not.toThrow();
  });

  it("puts the sign-up form in the masthead and numbers the issues, newest first", async () => {
    const list = vi.fn(async (collection: string, options?: Record<string, unknown>) => lists(collection, options));
    const { html } = await render(theme(), reader({}, list), "/");
    expect(list).toHaveBeenCalledWith("blog-posts", expect.objectContaining({ perPage: 12, sort: "-publishedAt", urls: "1" }));
    expect(html).toContain('data-theme="dispatch"');
    expect(html).toContain('data-scheme="auto"');
    expect(html).toContain('class="nl-signup"');
    expect(html).toContain("Get every issue by email");
    expect(html).toContain("Issue 14");
    expect(html).toContain("Issue 13");
    expect(html).toContain("Fourteenth &lt;edition&gt;");
    expect(html).toContain('class="dp-issue-link" href="/blog/14"');
    expect(html).toContain("4 min read");
    // The header's Subscribe button follows the newsletter page's own address.
    expect(html).toContain('class="dp-button" href="/letters"');
  });

  it("keeps issue numbers on later pages, and drops the masthead there", async () => {
    const { html } = await render(theme(), reader({}), "/", "2");
    expect(html).toContain("Issue 2");
    expect(html).toContain("Issue 1");
    expect(html).not.toContain("Get every issue by email");
  });

  it("leaves out dates and asks for a name when told to", async () => {
    const { html } = await render(theme({ showDates: false, askName: true, colorScheme: "light", tagline: "Notes weekly" }), reader({}), "/");
    expect(html).not.toContain("January 2, 2026");
    expect(html).toContain('name="name"');
    expect(html).toContain("Notes weekly");
    expect(html).toContain('data-scheme="light"');
  });

  it("ends an issue with the sign-up form, beside the blog plugin's parts", async () => {
    const post: ResolvedAddress = { type: "record", collection: "blog-posts", path: "/blog/hi", record: { id: 7, title: "Hello <b>", excerpt: "A lead", publishedAt: "2026-01-02T00:00:00.000Z", body: [] } };
    const { page, html } = await render(theme(), reader({ "/blog/hi": post }), "/blog/hi");
    expect(page).toMatchObject({ template: "blog-posts", source: "theme" });
    expect(html).toContain("Hello &lt;b&gt;");
    expect(html).toContain("A lead");
    expect(html).toContain("Enjoyed this issue?");
    expect(html).toContain('class="nl-signup"');
    expect(html).toContain('class="bl-meta"');
  });

  it("styles the newsletter's own page, without a Subscribe button in the header", async () => {
    const newsletterPage: ResolvedAddress = { type: "record", collection: "newsletter-page", path: "/newsletter", record: { id: 1, title: "Join <us>" } };
    const { page, html } = await render(theme(), reader({ "/newsletter": newsletterPage }), "/newsletter");
    expect(page).toMatchObject({ template: "newsletter-page", source: "theme" });
    expect(html).toContain("Join &lt;us&gt;");
    expect(html).toContain("dp-signup-hero");
    expect(html).not.toContain('class="dp-button"');
  });
});
