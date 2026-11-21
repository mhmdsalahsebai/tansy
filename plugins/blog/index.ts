import { z } from "zod";
import { defineBlock, definePlugin, defineRoute, type AfterHookContext, type BeforeHookContext, type ExtensionContext, type RecordsApi } from "tansy/plugin";
import { blogRoles, blogSchema, BYLINE_FIELD, COLLECTIONS, CONTRACT } from "./schema";
import { COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import { atom, excerptOf, readingMinutes, rss, slugify, type FeedItem } from "./text";

export interface BlogOptions {
  /** Where the public site lives, such as https://example.com. Feeds need absolute links. */
  siteUrl: string;
  /** The prefix of the addresses created on first install. After that, edit URL patterns in the dashboard. */
  basePath?: string;
  /** "moderated" holds new comments for review, "open" shows them straight away, and "off" refuses them. Until changed under Blog → Settings. */
  comments?: "off" | "moderated" | "open";
  /** Entries in each feed, until changed under Blog → Settings. */
  feedItems?: number;
  /** Who to email when a comment is waiting for review, until changed under Blog → Settings. */
  notify?: string;
}

const optionsSchema = z.strictObject({
  siteUrl: z.url({ protocol: /^https?$/ }),
  basePath: z.string().regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, 'Use a path such as "/blog".'),
  comments: z.enum(["off", "moderated", "open"]),
  feedItems: z.number().int().min(1).max(100),
  notify: z.email().optional(),
});

/** How many comments one person may post a minute. */
const COMMENTS_PER_MINUTE = 5;

/** The field a missing slug is made from, by collection. */
const SLUG_SOURCE: Record<string, string> = { "blog-posts": "title", "blog-categories": "name", "blog-tags": "name" };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const idOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);

/** Fields the owner may have removed are left alone, or the save would fail on a field that isn't there. */
async function fieldsOf(context: ExtensionContext, slug: string) {
  return new Set((await context.schema.describe(slug))?.fields.map((field) => field.name) ?? []);
}

async function uniqueSlug(records: RecordsApi, slug: string, base: string, ownId: unknown) {
  for (let attempt = 1; attempt <= 50; attempt++) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 75)}-${attempt}`;
    // slugify only produces letters, digits and hyphens, so the filter can't be broken out of.
    const { items } = await records.list(slug, { filter: `slug = "${candidate}"`, perPage: 2, fields: "id" });
    if (!items.some((item) => item.id !== ownId)) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

/** Fills a missing slug, excerpt and reading time. On an update, `values` holds only what changed. */
async function prepareContent(context: BeforeHookContext) {
  const { collection, values, record } = context;
  const source = SLUG_SOURCE[collection.slug];
  if (!source) return;
  const fields = await fieldsOf(context, collection.slug);
  const current = (name: string) => (Object.hasOwn(values, name) ? values[name] : record?.[name]);

  if (fields.has("slug") && !str(current("slug"))) {
    values.slug = await uniqueSlug(context.system.records, collection.slug, slugify(str(current(source))), record?.id);
  }
  if (collection.slug !== "blog-posts") return;
  const body = current("body");
  if (fields.has("readingMinutes") && (Object.hasOwn(values, "body") || !record)) values.readingMinutes = readingMinutes(body);
  if (fields.has("excerpt") && !str(current("excerpt")).trim()) {
    const excerpt = excerptOf(body);
    if (excerpt) values.excerpt = excerpt;
  }
}

/** Choosing whose name is on a post. Editors hold it, authors don't. */
const CREDIT = "ext.blog:credit";

const changes = (context: BeforeHookContext, name: string) =>
  Object.hasOwn(context.values, name) && (context.values[name] ?? null) !== (context.record?.[name] ?? null);

/**
 * A post's author is the person who wrote it, and its byline shows their name, taken from
 * their account when the post is created. Someone who may credit others can write any
 * byline, such as a guest's. Anyone else always gets their own name, and can't change it.
 */
async function credit(context: BeforeHookContext) {
  const { collection, values, userId, event } = context;
  if (collection.slug !== "blog-posts" || !(await fieldsOf(context, "blog-posts")).has("byline")) return;
  const credits = context.can(CREDIT);
  if (event === "record.beforeUpdate") {
    if (!credits && changes(context, "byline")) context.reject("Only an editor can change a post's byline.", "byline");
    return;
  }
  if (event !== "record.beforeCreate" || (credits && str(values.byline).trim())) return;
  const name = userId ? (await context.system.users.get(userId))?.name.trim().slice(0, 120) : "";
  values.byline = name || null;
}

async function underRateLimit(context: BeforeHookContext, userId: string) {
  const key = `comments-by:${userId}`;
  const now = Date.now();
  const recent = ((await context.store.get(key)) as number[] | null ?? []).filter((at) => typeof at === "number" && now - at < 60_000);
  if (recent.length >= COMMENTS_PER_MINUTE) return false;
  await context.store.set(key, [...recent, now]);
  return true;
}

interface BlogSettings { comments: "off" | "moderated" | "open"; feedItems: number; notify: string }
const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as BlogSettings;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function commentHooks() {
  const prepare = async (context: BeforeHookContext) => {
    const { values, reject, userId } = context;
    const mode = (await settingsOf(context)).comments;
    if (mode === "off") reject("Comments are closed.");
    if (!userId) reject("Sign in to comment.");

    // Read as a visitor, so only a published post can be commented on.
    const postId = idOf(values.post);
    const post = postId === null ? null : await context.records.get("blog-posts", postId).catch(() => null);
    if (!post || post.allowComments === false) reject("This post isn't taking comments.", "post");

    const parentId = idOf(values.parent);
    if (parentId !== null) {
      const parent = await context.system.records.get("blog-comments", parentId).catch(() => null);
      if (!parent || parent.post !== postId || parent.state !== "approved" || idOf(parent.parent) !== null) reject("You can reply only to an approved comment on the same post, one level deep.", "parent");
    }
    if (!(await underRateLimit(context, userId!))) reject("You're commenting too quickly. Wait a minute, then try again.");

    values.name = str(values.name).trim();
    values.body = str(values.body).trim();
    // Never what the commenter sent: only moderators decide this.
    values.state = mode === "open" ? "approved" : "pending";
  };

  const keepPlace = ({ values, record, reject }: BeforeHookContext) => {
    for (const name of ["post", "parent"]) {
      if (Object.hasOwn(values, name) && (values[name] ?? null) !== (record?.[name] ?? null)) reject("A comment can't move to another post or thread.", name);
    }
  };

  const announce = async (context: AfterHookContext) => {
    const { record, mail } = context;
    const notify = (await settingsOf(context)).notify.trim();
    if (!EMAIL.test(notify) || record.state !== "pending") return;
    await mail.send({
      to: notify,
      subject: "A comment is waiting for review",
      body: `${str(record.name)} commented on post ${String(record.post)}:\n\n${str(record.body).slice(0, 1000)}\n\nApprove it or mark it as spam under Blog → Comments to review in the dashboard.`,
    });
  };

  return { prepare, keepPlace, announce };
}

/** A language's feed lists posts published in it, at their addresses in it. Null on a site with one language. */
interface FeedLanguage { locale: string; href: (path: string) => string }

async function feedItems(records: RecordsApi, siteUrl: string, limit: number, language: FeedLanguage | null): Promise<FeedItem[]> {
  // The list rule already hides drafts from visitors. The filter keeps them out for a signed-in editor too.
  const { items } = await records.list("blog-posts", { filter: 'status = "published"', sort: "-publishedAt", perPage: limit, fields: "id,title,excerpt,publishedAt,updatedAt", urls: "1", ...(language ? { locale: language.locale, fallback: "none" } : {}) });
  const address = (path: string) => {
    const href = language ? language.href(path) : path;
    return /^https?:\/\//.test(href) ? href : `${siteUrl}${href}`;
  };
  const iso = (value: unknown, fallback: string) => {
    const date = new Date(str(value) || fallback);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  };
  return items.filter((item) => typeof item.recordPath === "string").map((item) => {
    const publishedAt = iso(item.publishedAt, "");
    return { title: str(item.title), url: address(str(item.recordPath)), summary: str(item.excerpt), publishedAt, updatedAt: iso(item.updatedAt, publishedAt) };
  });
}

async function feedTitle(records: RecordsApi, locale?: string) {
  const home = await records.list("blog-home", { perPage: 1, fields: "title", ...(locale ? { locale } : {}) }).catch(() => null);
  return str(home?.items[0]?.title) || "Blog";
}

const FEED_REASON = "Feed readers fetch it signed out. It lists only published posts the list rule shows the caller.";

/** Turns the CMS into a blog: posts, categories, tags, comments, feeds, and author and editor roles. See docs/plugins/blog.md. */
export function blog(options: BlogOptions) {
  const value = { basePath: "/blog", comments: "moderated" as const, feedItems: 20, ...options, siteUrl: options.siteUrl.replace(/\/+$/, "") };
  const comments = commentHooks();
  const forContent = (hook: (context: BeforeHookContext) => unknown) => async (context: BeforeHookContext) => {
    if (SLUG_SOURCE[context.collection.slug]) await prepareContent(context);
    await credit(context);
    if (context.collection.slug === "blog-comments") await hook(context);
  };

  const feed = (path: string, render: typeof rss, type: string) => defineRoute({
    method: "GET",
    path,
    root: true,
    access: "public",
    reason: FEED_REASON,
    handler: async (context) => {
      const { records, schema } = context;
      // One feed per language, as ?locale=fr. Without it, or on a site with one language, the default.
      const languages = await schema.languages();
      const asked = new URL(context.request.url).searchParams.get("locale");
      const locale = languages.items.find((item) => item.code === asked)?.code ?? languages.defaultLocale;
      const language = languages.items.length > 1 ? { locale, href: (to: string) => languages.href(to, locale) } : null;
      // A tenant's feed links to its own domain, or under its path prefix until it has one
      // (core/scope). Written one after the other: new URL() would drop a path on the base.
      const siteUrl = (await context.scope.siteUrl()) ?? value.siteUrl;
      // The feed's own address, which is served at the root of a domain rather than under a
      // path prefix, so the self link starts at the origin.
      const feedUrl = `${new URL(siteUrl).origin}${path}${language && locale !== languages.defaultLocale ? `?locale=${encodeURIComponent(locale)}` : ""}`;
      const body = render({ title: await feedTitle(records, language?.locale), siteUrl, feedUrl, items: await feedItems(records, siteUrl, (await settingsOf(context)).feedItems, language) });
      return new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=300" } });
    },
  });

  return definePlugin({
    name: "blog",
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { server: "@tansy/blog/admin", client: "@tansy/blog/client", render: "@tansy/blog/render" },
    csp: { frame: ["https://www.youtube-nocookie.com", "https://player.vimeo.com"] },
    options: { schema: optionsSchema, value },
    settings: {
      permission: "ext.blog:moderate",
      fields: [
        { name: "comments", type: "select", perScope: true, default: value.comments, label: "Comments", options: [{ label: "Held for review", value: "moderated" }, { label: "Shown straight away", value: "open" }, { label: "Off", value: "off" }] },
        { name: "notify", type: "text", perScope: true, default: value.notify ?? "", maxLength: 320, label: "Email for comments to review", description: "Who to tell when a comment is waiting. Leave empty for nobody." },
        { name: "feedItems", type: "number", perScope: true, integer: true, min: 1, max: 100, default: value.feedItems, label: "Posts in feeds", description: "How many of the latest posts the RSS and Atom feeds list." },
      ],
    },
    messages,
    permissions: { "ext.blog": ["moderate", "credit"] },
    contract: CONTRACT,
    blocks: [
      // Same fields as the blocks the blog theme used to create, so a site that had them keeps its stored blocks as they are.
      defineBlock({ name: "blog_text", label: "Text", labels: { ar: "نص" }, category: "Text", fields: [{ name: "body", type: "rich_text", config: { labels: { ar: "النص" } } }] }),
      defineBlock({ name: "blog_quote", label: "Quote", labels: { ar: "اقتباس" }, category: "Text", fields: [{ name: "text", type: "text", config: { required: true, labels: { ar: "النص" } } }, { name: "source", type: "text", config: { labels: { ar: "المصدر" } } }] }),
      defineBlock({
        name: "blog_callout",
        label: "Callout",
        labels: { ar: "تنبيه" },
        category: "Text",
        defaults: { tone: "info" },
        fields: [
          { name: "tone", type: "radio", config: { labels: { ar: "النوع" }, options: [{ label: "Note", labels: { ar: "ملاحظة" }, value: "info" }, { label: "Tip", labels: { ar: "نصيحة" }, value: "tip" }, { label: "Warning", labels: { ar: "تحذير" }, value: "warning" }] } },
          { name: "body", type: "rich_text", config: { labels: { ar: "النص" } } },
        ],
      }),
      defineBlock({
        name: "blog_image",
        label: "Image",
        labels: { ar: "صورة" },
        category: "Media",
        fields: [
          { name: "image", type: "image", config: { required: true, labels: { ar: "الصورة" } } },
          { name: "alt", type: "text", config: { maxLength: 200, labels: { ar: "النص البديل" } } },
          { name: "caption", type: "text", config: { maxLength: 300, labels: { ar: "التعليق" } } },
        ],
      }),
      defineBlock({
        name: "blog_embed",
        label: "Video",
        labels: { ar: "فيديو" },
        category: "Media",
        fields: [
          { name: "url", type: "url", config: { required: true, allowedProtocols: ["https"], allowedDomains: ["youtube.com", "youtu.be", "vimeo.com"], labels: { ar: "الرابط" } } },
          { name: "caption", type: "text", config: { maxLength: 300, labels: { ar: "التعليق" } } },
        ],
      }),
      defineBlock({
        name: "blog_code",
        label: "Code",
        labels: { ar: "رمز برمجي" },
        category: "Text",
        fields: [
          { name: "code", type: "code", config: { required: true, labels: { ar: "الرمز" } } },
          { name: "language", type: "text", config: { maxLength: 30, labels: { ar: "اللغة" } } },
        ],
      }),
    ],
    hooks: {
      "record.beforeCreate": forContent(comments.prepare),
      "record.beforeUpdate": forContent(comments.keepPlace),
      "record.afterCreate": async (context) => { if (context.collection.slug === "blog-comments") await comments.announce(context); },
    },
    routes: [feed("/feed.xml", rss, "application/rss+xml"), feed("/atom.xml", atom, "application/atom+xml")],
    migrations: [{
      id: "001-collections",
      up: async ({ schema, system }) => {
        for (const slug of COLLECTIONS) {
          if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the blog plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
        }
        await schema.apply(blogSchema(value.basePath));
        await system.records.create("blog-home", { status: "published", title: "Blog" });
      },
    }, {
      // Authors are people with a role, so a post names its writer instead of linking a profile.
      id: "002-authors-are-people",
      up: async ({ schema, roles }) => {
        if (await schema.describe("blog-posts")) await schema.addFields("blog-posts", [BYLINE_FIELD]);
        for (const role of blogRoles()) await roles.ensure(role);
      },
    }, {
      id: "003-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
      },
    }, {
      id: "004-field-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
      },
    }],
  });
}
