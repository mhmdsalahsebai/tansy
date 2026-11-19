import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Menu } from "@/components/stream/Menu";
import { normalizePath, redirectTarget } from "@/core/urls/path";
import { buildRecordPath, comparePatterns, matchPattern, patternShape, urlPatternProblem, type PatternField } from "@/core/urls/pattern";
import { seo } from "../../plugins/seo/index";

const field = (name: string, extra: Partial<PatternField> = {}): PatternField => ({ name, unique: false, hidden: false, routable: true, ...extra });

describe("normalizePath", () => {
  it("gives each path one spelling", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/caf%C3%A9")).toBe(normalizePath("/café"));
    expect(normalizePath("/a%2Fb")).toBe("/a%2Fb");
  });
  it.each(["", "a", "//evil.test", "/\\evil.test", "/a//b", "/a b", "/a?x=1", "/a#x", "/%", "/%E0%A4%A", "/%00", "/.", "/..", "/a/%2e%2e", `/${"a/".repeat(40)}`, `/${"a".repeat(3000)}`])("refuses %j", (path) => {
    expect(normalizePath(path)).toBeNull();
  });
});

describe("redirectTarget", () => {
  it("keeps a query and fragment", () => expect(redirectTarget("/a/?x=1#y")).toBe("/a?x=1#y"));
  it.each(["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "/a?x=1 2", "/a?x\\y"])("refuses %j", (target) => {
    expect(redirectTarget(target)).toBeNull();
  });
});

describe("urlPatternProblem", () => {
  const fields = [field("slug", { unique: true }), field("title"), field("secret", { hidden: true, unique: true }), field("cover", { routable: false, unique: true })];
  it.each([["/blog/:slug"], ["/:title/:slug"], ["/x/:id"], ["/x.y-z_~/:id"]])("accepts %s", (pattern) => expect(urlPatternProblem(pattern, "base", fields)).toBeNull());
  it.each([["/blog/:title", /unique/], ["/blog/:secret", /hidden/], ["/blog/:cover", /text field/], ["/blog/:nope", /no field/], ["/blog", /parameter/], ["blog/:slug", /Start with/], ["/Blog/:slug", /Start with/], ["/:slug/:slug", /once/], ["/dashboard/:slug", /CMS itself/], ["/api", /CMS itself/]])("refuses %s", (pattern, message) => {
    expect(urlPatternProblem(pattern, "base", fields)).toMatch(message);
  });
  it("gives a singleton one fixed address, and a view none", () => {
    expect(urlPatternProblem("/", "singleton", [])).toBeNull();
    expect(urlPatternProblem("/about", "singleton", [])).toBeNull();
    expect(urlPatternProblem("/about/:id", "singleton", [])).toMatch(/one address/);
    expect(urlPatternProblem("/x/:id", "view", [])).toMatch(/View/);
  });
});

describe("matching and building addresses", () => {
  it("reads values back from a path", () => {
    expect(matchPattern("/blog/:slug", "/blog/caf%C3%A9")).toEqual(new Map([["slug", "café"]]));
    expect(matchPattern("/blog/:slug", "/news/x")).toBeNull();
    expect(matchPattern("/blog/:slug", "/blog")).toBeNull();
    expect(matchPattern("/", "/")).toEqual(new Map());
  });
  it("only takes ids a record could have", () => {
    expect(matchPattern("/x/:id", "/x/12")).toEqual(new Map([["id", 12]]));
    for (const id of ["0", "01", "-1", "1e3", "2147483648"]) expect(matchPattern("/x/:id", `/x/${id}`)).toBeNull();
  });
  it("builds an address that resolves back to the record", () => {
    const path = buildRecordPath("/blog/:slug", { slug: "a/b c" });
    expect(path).toBe("/blog/a%2Fb%20c");
    expect(matchPattern("/blog/:slug", path!)).toEqual(new Map([["slug", "a/b c"]]));
  });
  it("has no address for a value that can't be in one", () => {
    for (const slug of [null, "", ".", "..", "a\u0000", { a: 1 }]) expect(buildRecordPath("/blog/:slug", { slug })).toBeNull();
  });
  it("tries fixed words before parameters, and treats parameter names as the same shape", () => {
    expect(["/:a/x", "/blog/:b", "/blog/archive"].sort(comparePatterns)).toEqual(["/blog/archive", "/blog/:b", "/:a/x"]);
    expect(patternShape("/blog/:slug")).toBe(patternShape("/blog/:title"));
  });
});

describe("<Menu>", () => {
  const item = (id: string, value: Record<string, unknown>) => ({ id, type: "menu_item", value });
  const html = (items: unknown) => renderToStaticMarkup(createElement(Menu, { items }));

  it("renders nested links", () => {
    expect(html([item("a", { label: "About", url: "/about", children: [item("b", { label: "Team", url: "https://example.com/t", newTab: true })] })]))
      .toBe('<ul><li><a href="/about">About</a><ul><li><a href="https://example.com/t" target="_blank" rel="noopener noreferrer">Team</a></li></ul></li></ul>');
  });
  it.each(["javascript:alert(1)", "//evil.test", "/\\evil.test", "data:text/html,x", 7])("shows %j as text, not a link", (url) => {
    expect(html([item("a", { label: "X", url })])).toBe("<ul><li>X</li></ul>");
  });
  it("renders nothing for anything but a list of items", () => {
    expect(html(null)).toBe("");
    expect(html([])).toBe("");
  });
});

describe("the SEO plugin's sitemap", () => {
  const plugin = seo({ siteUrl: "https://example.com/", collections: ["posts"] });
  const handler = plugin.routes![0].handler as (context: unknown) => Promise<Response>;
  const oneLanguage = { languages: async () => ({ defaultLocale: "en", items: [{ code: "en", label: "English", direction: "ltr" }], href: (path: string) => path }) };

  it("lists addresses from URL patterns, escaped, and skips records with none", async () => {
    const seen: unknown[] = [];
    const records = { list: async (_slug: string, query: unknown) => { seen.push(query); return { totalPages: 1, items: [{ id: 1, recordPath: "/blog/a&b", updatedAt: "2026-01-01" }, { id: 2, recordPath: null }] }; } };
    const body = await (await handler({ records, schema: oneLanguage })).text();
    expect(body).toContain("<loc>https://example.com/blog/a&#38;b</loc>");
    expect(body.match(/<url>/g)).toHaveLength(1);
    expect(body).not.toContain("xhtml:link");
    expect(seen[0]).toMatchObject({ urls: "1", filter: 'status = "published"' });
  });
  it("leaves out a collection it can't read", async () => {
    const body = await (await handler({ records: { list: async () => { throw new Error("locked"); } }, schema: oneLanguage })).text();
    expect(body).not.toContain("<url>");
  });
  it("lists each language's address, with hreflang alternates, only where a record is published in it", async () => {
    const schema = { languages: async () => ({ defaultLocale: "en", items: [{ code: "en", label: "English", direction: "ltr" }, { code: "fr", label: "Français", direction: "ltr" }], href: (path: string, locale: string) => (locale === "en" ? path : `/${locale}${path}`) }) };
    const seen: Array<Record<string, unknown>> = [];
    const records = { list: async (_slug: string, query: Record<string, unknown>) => {
      seen.push(query);
      return query.locale === "fr" ? { totalPages: 1, items: [{ id: 1, recordPath: "/blog/lancement" }] } : { totalPages: 1, items: [{ id: 1, recordPath: "/blog/launch" }, { id: 2, recordPath: "/blog/only-english" }] };
    } };
    const body = await (await handler({ records, schema })).text();
    expect(seen.map((query) => [query.locale, query.fallback])).toEqual([["en", "none"], ["fr", "none"]]);
    expect(body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(body.match(/<url>/g)).toHaveLength(3);
    expect(body).toContain('<loc>https://example.com/fr/blog/lancement</loc><xhtml:link rel="alternate" hreflang="en" href="https://example.com/blog/launch"/><xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/blog/lancement"/><xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/blog/launch"/>');
    // A record in one language has no alternates to list.
    expect(body).toContain("<url><loc>https://example.com/blog/only-english</loc></url>");
  });
});
