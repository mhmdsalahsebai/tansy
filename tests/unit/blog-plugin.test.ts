import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BeforeHookContext, CollectionShape, RecordValues } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { schemaDocument } from "@/core/schema/portable";
import { pluginRenderers } from "@/components/stream/StreamField";
import { blog } from "../../plugins/blog/index";
import blogRenderers, { MorePosts, PostComments } from "../../plugins/blog/render";
import { blogRoles, blogSchema, COLLECTIONS, CONTRACT } from "../../plugins/blog/schema";
import { atom, embedUrl, escapeXml, excerptOf, readingMinutes, rss, slugify } from "../../plugins/blog/text";

const rich = (...paragraphs: string[]) => ({ type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
const block = (type: string, value: Record<string, unknown>) => ({ id: type, type, v: 1, value });

describe("blog text helpers", () => {
  it("make slugs from any title", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Crème brûlée -- à la carte ")).toBe("creme-brulee-a-la-carte");
    expect(slugify("ستة")).toBe("post");
    expect(slugify("a".repeat(200))).toHaveLength(80);
  });

  it("count reading time from prose blocks only, joining marked text runs", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(readingMinutes([])).toBe(1);
    expect(readingMinutes([block("blog_text", { body: rich(words(300)) }), block("blog_code", { code: words(5000) })])).toBe(2);
    const marked = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bo", marks: [{ type: "bold" }] }, { type: "text", text: "ld move" }] }] };
    expect(excerptOf([block("blog_text", { body: marked })])).toBe("bold move");
  });

  it("take the excerpt from the first paragraph, cut at a word", () => {
    const blocks = [block("blog_image", { image: "f" }), block("blog_text", { body: rich("First paragraph here.", "Second.") })];
    expect(excerptOf(blocks)).toBe("First paragraph here.");
    const cut = excerptOf([block("blog_text", { body: rich("one two three four five six seven") })], 20);
    expect(cut).toBe("one two three four…");
    expect(excerptOf("not blocks")).toBe("");
  });

  it("embed only YouTube and Vimeo, over https", () => {
    expect(embedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(embedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(embedUrl("https://vimeo.com/76979871")).toBe("https://player.vimeo.com/video/76979871");
    for (const bad of ["http://youtu.be/dQw4w9WgXcQ", "https://evil.test/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=<script>", "javascript:alert(1)", "not a url"]) expect(embedUrl(bad), bad).toBeNull();
  });

  it("escape everything in feeds", () => {
    const item = { title: "<b>&</b>", url: "https://x.test/a?b=1&c=2", summary: "\"quoted\"\u0001", publishedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" };
    const feed = { title: "T & T", siteUrl: "https://x.test", feedUrl: "https://x.test/feed.xml", items: [item] };
    for (const xml of [rss(feed), atom(feed)]) {
      expect(xml).not.toMatch(/<b>|&c=|\u0001/);
      expect(xml).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
      expect(xml).toContain("T &amp; T");
    }
    expect(rss(feed)).toContain("<pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate>");
    expect(atom(feed)).toContain("<updated>2026-01-03T00:00:00.000Z</updated>");
    expect(escapeXml("'")).toBe("&apos;");
  });
});

describe("blog plugin manifest", () => {
  it("passes the startup checks, and refuses bad options", () => {
    expect(() => assertPluginManifest(blog({ siteUrl: "https://example.com/" }))).not.toThrow();
    expect(blog({ siteUrl: "https://example.com/" }).options?.value).toMatchObject({ siteUrl: "https://example.com", basePath: "/blog", comments: "moderated" });
    // Options are the settings' defaults, until someone changes them in the dashboard.
    const fields = blog({ siteUrl: "https://example.com", comments: "open", feedItems: 5 }).settings!.fields;
    expect(Object.fromEntries(fields.map((field) => [field.name, field.default]))).toEqual({ comments: "open", notify: "", feedItems: 5 });
    expect(() => assertPluginManifest(blog({ siteUrl: "ftp://example.com" }))).toThrow(/siteUrl/);
    expect(() => assertPluginManifest(blog({ siteUrl: "https://example.com", basePath: "blog/" }))).toThrow(/basePath/);
  });

  it("creates a schema that imports, and that every contract field is part of", () => {
    const document = schemaDocument.parse(blogSchema("/journal"));
    expect(document.collections.find((c) => c.slug === "blog-posts")?.urlPattern).toBe("/journal/:slug");
    for (const [slug, fields] of Object.entries(CONTRACT)) {
      const collection = document.collections.find((c) => c.slug === slug)!;
      for (const [name, type] of Object.entries(fields)) expect(collection.fields.find((f) => f.name === name)?.type, `${slug}.${name}`).toBe(type);
    }
  });

  it("keeps the blocks the blog theme used to create as they were, so stored blocks keep their version", () => {
    const blocks = blog({ siteUrl: "https://example.com" }).blocks!;
    // Words in other languages don't change a block's version, so they're left out.
    const shape = (name: string) => blocks.find((b) => b.name === name)?.fields.map(({ config: { labels: _labels, ...config } = {}, ...field }) => ({ ...field, config }));
    expect(shape("blog_text")).toEqual([{ name: "body", type: "rich_text", config: {} }]);
    expect(shape("blog_quote")).toEqual([{ name: "text", type: "text", config: { required: true } }, { name: "source", type: "text", config: {} }]);
  });

  it("declares roles named after it, for its own collections, with authors limited to their own posts", () => {
    const roles = blogRoles();
    expect(roles.map((role) => role.name)).toEqual(["blog-author", "blog-editor"]);
    const author = roles[0];
    expect(author.records).toEqual({ "blog-posts": ["create", "list:own", "read:own", "update:own", "delete:own"] });
    expect(author.permissions).not.toContain("ext.blog:moderate");
    expect(author.permissions).not.toContain("ext.blog:credit");
    expect(roles[1].permissions).toContain("ext.blog:credit");
    for (const role of roles) expect(Object.keys(role.records ?? {}).every((slug) => (COLLECTIONS as readonly string[]).includes(slug))).toBe(true);
    expect(blog({ siteUrl: "https://example.com" }).migrations?.map((m) => m.id)).toEqual(["001-collections", "002-authors-are-people", "003-names-in-languages", "004-field-names-in-languages"]);
  });

  it("renders only its own collections", () => {
    expect(() => pluginRenderers("blog", blogRenderers)).not.toThrow();
    expect(Object.keys(blogRenderers.templates!).every((slug) => slug.startsWith("blog-"))).toBe(true);
  });
});

/** A before-hook context with in-memory services. */
/** What Blog → Settings holds: the defaults unless a test changes them. */
const settings = (values: Record<string, unknown> = {}) => ({ get: async () => ({ comments: "moderated", feedItems: 20, notify: "", ...values }) });

function hookContext(slug: string, values: RecordValues, overrides: Partial<BeforeHookContext> = {}) {
  const fields = Object.fromEntries(blogSchema("/blog").collections.map((c) => [c.slug, c.fields.map((f) => f.name)]));
  const stored = new Map<string, unknown>();
  const describe = vi.fn(async (name: string): Promise<CollectionShape | null> => (fields[name] ? { slug: name, name, type: "base", urlPattern: null, fields: fields[name].map((field) => ({ name: field, type: "text", config: {} })) } : null));
  const context = {
    event: "record.beforeCreate",
    collection: { id: 1, slug, name: slug },
    userId: "user-1",
    // An editor unless a test says otherwise.
    can: vi.fn(() => true),
    values,
    records: { list: vi.fn(), get: vi.fn(async () => ({ id: 5, allowComments: true })), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    system: {
      records: { list: vi.fn(async () => ({ page: 1, perPage: 2, totalItems: 0, totalPages: 0, items: [] })), get: vi.fn(), create: vi.fn(async (_: string, data: RecordValues) => ({ id: 40, ...data })), update: vi.fn(), delete: vi.fn() },
      users: { get: vi.fn(async (id: string) => ({ id, name: "Ann Lee", email: "ann@example.com" })), findByEmail: vi.fn(), getValues: vi.fn(), setValues: vi.fn() },
    },
    store: { get: async (key: string) => stored.get(key) ?? null, set: async (key: string, value: unknown) => { stored.set(key, value); }, delete: async () => {}, list: async () => [] },
    mail: { send: vi.fn(async () => {}) },
    schema: { describe },
    settings: settings(),
    reject: (message: string): never => { throw new Error(message); },
    ...overrides,
  } as unknown as BeforeHookContext;
  return context;
}

describe("blog hooks", () => {
  const plugin = blog({ siteUrl: "https://example.com" });
  const beforeCreate = plugin.hooks!["record.beforeCreate"]!;
  const beforeUpdate = plugin.hooks!["record.beforeUpdate"]!;

  it("fill a post's slug, excerpt and reading time, finding a free slug", async () => {
    const context = hookContext("blog-posts", { title: "Hello World", body: [block("blog_text", { body: rich("Words here.") })] });
    vi.mocked(context.system.records.list).mockResolvedValueOnce({ page: 1, perPage: 2, totalItems: 1, totalPages: 1, items: [{ id: 99 }] });
    await beforeCreate(context);
    expect(context.values).toMatchObject({ slug: "hello-world-2", excerpt: "Words here.", readingMinutes: 1 });
  });

  it("put the writer's name on a new post", async () => {
    const first = hookContext("blog-posts", { title: "First" });
    await beforeCreate(first);
    expect(first.system.users.get).toHaveBeenCalledWith("user-1");
    expect(first.values.byline).toBe("Ann Lee");
    const signedOut = hookContext("blog-posts", { title: "T" }, { userId: null });
    await beforeCreate(signedOut);
    expect(signedOut.values.byline).toBeNull();
  });

  it("let an editor write any byline, and give anyone else their own name, unchangeable", async () => {
    const guest = hookContext("blog-posts", { title: "T", byline: "A Guest" });
    await beforeCreate(guest);
    expect(guest.values.byline).toBe("A Guest");

    const author = { can: vi.fn(() => false) };
    const chose = hookContext("blog-posts", { title: "T", byline: "Someone Famous" }, author);
    await beforeCreate(chose);
    expect(chose.values.byline).toBe("Ann Lee");
    expect(chose.can).toHaveBeenCalledWith("ext.blog:credit");

    await expect(beforeUpdate(hookContext("blog-posts", { byline: "Someone Famous" }, { ...author, event: "record.beforeUpdate", record: { id: 1, byline: "Ann Lee" } }))).rejects.toThrow(/editor/);
    const same = hookContext("blog-posts", { byline: "Ann Lee", title: "x" }, { ...author, event: "record.beforeUpdate", record: { id: 1, byline: "Ann Lee" } });
    await beforeUpdate(same);
    expect(same.values.title).toBe("x");
    const editor = hookContext("blog-posts", { byline: "A Guest" }, { event: "record.beforeUpdate", record: { id: 1, byline: "Ann Lee" } });
    await beforeUpdate(editor);
    expect(editor.values.byline).toBe("A Guest");
  });

  it("keep what the author wrote, and skip fields the owner removed", async () => {
    const context = hookContext("blog-posts", { title: "T", slug: "mine", excerpt: "Mine", body: [] });
    vi.mocked(context.schema.describe).mockResolvedValue({ slug: "blog-posts", name: "Posts", type: "base", urlPattern: null, fields: [{ name: "slug", type: "text", config: {} }, { name: "excerpt", type: "text", config: {} }] });
    await beforeCreate(context);
    expect(context.values).toEqual({ title: "T", slug: "mine", excerpt: "Mine", body: [] });
  });

  it("recount reading time on update only when the body changes", async () => {
    const unchanged = hookContext("blog-posts", { title: "New" }, { event: "record.beforeUpdate", record: { id: 3, slug: "s", excerpt: "e", body: [] } });
    await beforeUpdate(unchanged);
    expect(unchanged.values).toEqual({ title: "New" });
  });

  it("force a new comment's state, whatever the commenter sent", async () => {
    const context = hookContext("blog-comments", { post: 5, name: " Ann ", body: " Hi ", state: "approved" });
    await beforeCreate(context);
    expect(context.values).toMatchObject({ name: "Ann", body: "Hi", state: "pending" });
    const open = hookContext("blog-comments", { post: 5, name: "A", body: "B" }, { settings: settings({ comments: "open" }) });
    await beforeCreate(open);
    expect(open.values.state).toBe("approved");
  });

  it("refuse comments on a post a visitor can't see, or one closed to comments", async () => {
    const hidden = hookContext("blog-comments", { post: 5, name: "A", body: "B" });
    vi.mocked(hidden.records.get).mockRejectedValue(new Error("404"));
    await expect(beforeCreate(hidden)).rejects.toThrow(/isn't taking comments/);
    const closed = hookContext("blog-comments", { post: 5, name: "A", body: "B" });
    vi.mocked(closed.records.get).mockResolvedValue({ id: 5, allowComments: false });
    await expect(beforeCreate(closed)).rejects.toThrow(/isn't taking comments/);
    await expect(beforeCreate(hookContext("blog-comments", { post: 5 }, { settings: settings({ comments: "off" }) }))).rejects.toThrow(/closed/);
  });

  it("allow replies one level deep, to approved comments on the same post", async () => {
    const reply = (parent: RecordValues) => {
      const context = hookContext("blog-comments", { post: 5, parent: 8, name: "A", body: "B" });
      vi.mocked(context.system.records.get).mockResolvedValue(parent);
      return beforeCreate(context);
    };
    await expect(reply({ id: 8, post: 5, state: "approved", parent: null })).resolves.toBeUndefined();
    for (const bad of [{ id: 8, post: 6, state: "approved" }, { id: 8, post: 5, state: "pending" }, { id: 8, post: 5, state: "approved", parent: 2 }]) await expect(reply(bad), JSON.stringify(bad)).rejects.toThrow(/one level deep/);
  });

  it("limit how fast one person comments", async () => {
    const context = hookContext("blog-comments", {});
    for (let i = 0; i < 5; i++) {
      context.values = { post: 5, name: "A", body: "B" };
      await beforeCreate(context);
    }
    context.values = { post: 5, name: "A", body: "B" };
    await expect(beforeCreate(context)).rejects.toThrow(/too quickly/);
  });

  it("keep a comment on its post and thread", async () => {
    const context = hookContext("blog-comments", { post: 6, state: "approved" }, { record: { id: 1, post: 5, parent: null } });
    await expect(beforeUpdate(context)).rejects.toThrow(/can't move/);
    const approving = hookContext("blog-comments", { state: "approved" }, { record: { id: 1, post: 5, parent: null } });
    await expect(beforeUpdate(approving)).resolves.toBeUndefined();
  });
});

describe("blog render parts", () => {
  const post = { id: 7, title: "Seven", tags: [1], allowComments: true } as never;
  const data = {
    related: { items: [{ id: 8, title: "Eight", recordPath: "/blog/eight" }], page: 1, perPage: 3, totalItems: 1, totalPages: 1 },
    comments: { items: [{ id: 1, name: "Ann", body: "Hi", parent: null, createdAt: "2026-01-01T00:00:00.000Z" }, { id: 2, name: "Bo", body: "Hey", parent: 1, createdAt: "2026-01-02T00:00:00.000Z" }], page: 1, perPage: 200, totalItems: 2, totalPages: 1 },
  } as never;
  const html = (node: ReactElement) => renderToStaticMarkup(node);
  const labelledBy = (markup: string, cls: string) => {
    const section = markup.match(new RegExp(`<section class="${cls}" aria-labelledby="([^"]+)"`));
    expect(section).not.toBeNull();
    return section![1];
  };

  it("render the plugin's defaults: h2 titles labelling their sections, an h3 over the form, and the class hooks", () => {
    const comments = html(createElement(PostComments, { post, data }));
    const id = labelledBy(comments, "bl-comments");
    expect(comments).toContain(`<h2 id="${id}" class="bl-comments-title">Comments</h2>`);
    expect(comments).toContain('<h3 class="bl-form-title">Leave a comment</h3>');
    expect(comments).toContain('<ol class="bl-thread bl-replies">');
    const more = html(createElement(MorePosts, { post, data }));
    expect(more).toContain(`<h2 id="${labelledBy(more, "bl-more")}" class="bl-more-title">More posts</h2>`);
    expect(more).toContain('<h2 class="bl-item-title">');
    const empty = html(createElement(PostComments, { post, data: {} as never }));
    expect(empty).toContain('class="bl-muted bl-comments-empty"');
  });

  it("take a heading's text, or hide it while the section keeps an accessible name", () => {
    expect(html(createElement(PostComments, { post, data, heading: "Discussion", formHeading: "Join in" }))).toMatch(/class="bl-comments-title">Discussion<\/h2>[\s\S]*class="bl-form-title">Join in<\/h3>/);
    const hidden = html(createElement(PostComments, { post, data, heading: false, formHeading: false }));
    expect(hidden).toContain('<section class="bl-comments" aria-label="Comments">');
    expect(hidden).not.toMatch(/<h[2-6]/);
    const more = html(createElement(MorePosts, { post, data, heading: false }));
    expect(more).toContain('<section class="bl-more" aria-label="More posts">');
    expect(more).not.toContain("bl-more-title");
  });

  it("let the theme set the heading levels, the form and post titles one below", () => {
    const comments = html(createElement(PostComments, { post, data, headingLevel: 3 }));
    expect(comments).toMatch(/<h3 id="[^"]+" class="bl-comments-title">/);
    expect(comments).toContain('<h4 class="bl-form-title">');
    expect(html(createElement(PostComments, { post, data, headingLevel: 6 }))).toContain('<h6 class="bl-form-title">');
    const more = html(createElement(MorePosts, { post, data, headingLevel: 4 }));
    expect(more).toMatch(/<h4 id="[^"]+" class="bl-more-title">/);
    expect(more).toContain('<h5 class="bl-item-title">');
  });

  it("leave outer spacing to the template: parts' own rules have none, the plugin's page adds it", () => {
    const css = readFileSync("plugins/blog/blog.css", "utf8");
    const rule = (selector: string) => css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    for (const part of [".bl-meta", ".bl-kicker", ".bl-list", ".bl-tags"]) expect(rule(part)).toMatch(/margin: 0;/);
    expect(css).not.toMatch(/^\.bl-(more|comments)\b/m);
    expect(rule(":where(.bl-main) > .bl-more, :where(.bl-main) > .bl-comments")).toMatch(/margin-top: var\(--site-space-section, 3rem\); padding-top: 1\.5rem; border-top: 1px solid/);
  });

  it("give two parts on one page different ids", () => {
    const page = html(createElement("main", null, createElement(PostComments, { post, data }), createElement(PostComments, { post, data }), createElement(MorePosts, { post, data }), createElement(MorePosts, { post, data })));
    const ids = [...page.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(page.split(`id="${id}"`)).toHaveLength(2);
  });
});
