import { z } from "zod";
import { defineBlock, definePlugin, defineRoute, type BeforeHookContext } from "tansy/plugin";
import { defineField } from "tansy/fields";

interface Options {
  /** Where the public site lives. */
  siteUrl: string;
  /** Collections that have a `title` and a `seo_title` field. */
  collections: string[];
  /** The collection link cards point at. */
  linkTarget?: string;
}

const xml = (text: string) => text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_PAGES = 50;

/** The example plugin from internal/NEXT_GEN_CMS_PLAN.md section 6: a field, a block, a hook, a route and a job. */
export function seoPlugin({ siteUrl, collections, linkTarget = "seo-targets" }: Options) {
  const fillTitle = ({ collection, values }: BeforeHookContext) => {
    if (collections.includes(collection.slug) && !values.seo_title && typeof values.title === "string") values.seo_title = values.title.slice(0, 70);
  };

  return definePlugin({
    name: "seo",
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { server: "@tansy/example-seo-plugin/admin", client: "@tansy/example-seo-plugin/client", render: "@tansy/example-seo-plugin/render" },
    options: { schema: z.object({ siteUrl: z.string(), collections: z.array(z.string().min(1)).min(1) }), value: { siteUrl, collections } },
    permissions: { "ext.seo": ["read"] },
    fields: [
      defineField({
        type: "seo_title",
        admin: { label: "SEO title", description: "Page title for search results", input: "text" },
        config: {},
        value: () => z.string().max(70),
        storage: () => ({ sql: "text" }),
      }),
      // An object value holding a record link and, optionally, a file. `refs` gives it the same link index, expansion and file rules as a built-in reference.
      defineField({
        type: "seo_link",
        admin: { label: "Internal link", description: "Link text, a record and an optional attachment" },
        config: { target: z.string().min(1).max(100) },
        value: () => z.strictObject({ label: z.string().min(1).max(200), id: z.number().int().positive(), file: z.string().min(1).max(255).optional() }),
        normalize: (value) => {
          const link = value as { label?: unknown } | null;
          return link && typeof link === "object" && typeof link.label === "string" ? { ...link, label: link.label.trim() } : value;
        },
        refs: (value, { target }) => ({ records: [{ collection: target, id: value.id }], files: value.file ? [value.file] : [] }),
        search: (value) => [value.label],
        summary: (value) => `${value.label} → #${value.id}`,
        operators: [],
        storage: () => ({ sql: "json" }),
      }),
    ],
    blocks: [
      defineBlock({
        name: "seo_faq",
        label: "FAQ",
        category: "Content",
        fields: [
          { name: "question", type: "text", config: { required: true } },
          { name: "answer", type: "text", config: { required: true } },
        ],
      }),
      defineBlock({
        name: "seo_card",
        label: "Link card",
        category: "Links",
        fields: [{ name: "link", type: "seo_link", config: { required: true, target: linkTarget } }],
      }),
      defineBlock({
        name: "seo_section",
        label: "Link section",
        category: "Links",
        defaults: { title: "Related" },
        fields: [
          { name: "title", type: "text" },
          { name: "cards", type: "stream", config: { allowedBlocks: ["seo_card"] } },
        ],
      }),
    ],
    hooks: { "record.beforeCreate": fillTitle },
    routes: [defineRoute({
      method: "GET",
      path: "/sitemap.xml",
      root: true,
      access: "public",
      reason: "Search engines read it signed out. It lists only what the collection's API rules show a visitor.",
      handler: async ({ records }) => {
        const urls: string[] = [];
        for (const slug of collections) {
          for (let page = 1; page <= MAX_PAGES; page++) {
            const result = await records.list(slug, { page, perPage: 200, filter: 'status = "published"', sort: "-id", fields: "id,updatedAt" }).catch(() => null);
            if (!result) break;
            for (const item of result.items) urls.push(`<url><loc>${xml(`${siteUrl}/${slug}/${item.id}`)}</loc>${item.updatedAt ? `<lastmod>${xml(String(item.updatedAt))}</lastmod>` : ""}</url>`);
            if (page >= result.totalPages) break;
          }
        }
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
      },
    })],
    jobs: [{
      name: "seo.report",
      cron: "0 3 * * *",
      handler: async ({ system }) => {
        for (const slug of collections) {
          const { totalItems } = await system.records.list(slug, { filter: 'seo_title = ""', perPage: 1 });
          console.info(`[seo] ${slug}: ${totalItems} records have no SEO title.`);
        }
      },
    }],
  });
}
