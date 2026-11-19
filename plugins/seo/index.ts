import { z } from "zod";
import { definePlugin, defineRoute, type BeforeHookContext } from "tansy/plugin";
import { defineField } from "tansy/fields";
import { messages } from "./messages";

interface Options {
  /** The public site's origin, such as https://example.com. */
  siteUrl: string;
  /** Slugs of the collections to list in the sitemap. Each needs a URL pattern. */
  collections: string[];
}

const options = z.object({ siteUrl: z.url(), collections: z.array(z.string().min(1)).min(1) });

const xml = (text: string) => text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_PAGES = 50;
const PER_PAGE = 200;
const SEO_TITLE_LIMIT = 70;

/** Titles and descriptions for search results, and a sitemap built from collections' URL patterns. */
export function seo({ siteUrl, collections }: Options) {
  const origin = siteUrl.replace(/\/$/, "");

  const fillTitle = ({ collection, values }: BeforeHookContext) => {
    if (collections.includes(collection.slug) && !values.seo_title && typeof values.title === "string") values.seo_title = values.title.slice(0, SEO_TITLE_LIMIT);
  };

  return definePlugin({
    name: "seo",
    version: "0.1.0",
    apiVersion: 1,
    requires: { cms: "^0.1.0" },
    options: { schema: options, value: { siteUrl, collections } },
    messages,
    fields: [
      defineField({
        type: "seo_title",
        admin: { label: "SEO title", description: "Page title for search results", input: "text" },
        config: {},
        value: () => z.string().max(SEO_TITLE_LIMIT),
        storage: () => ({ sql: "text" }),
      }),
      defineField({
        type: "seo_description",
        admin: { label: "SEO description", description: "Summary for search results", input: "text" },
        config: {},
        value: () => z.string().max(160),
        storage: () => ({ sql: "text" }),
      }),
    ],
    hooks: { "record.beforeCreate": fillTitle },
    routes: [defineRoute({
      method: "GET",
      path: "/sitemap.xml",
      root: true,
      access: "public",
      reason: "Search engines read it signed out. It lists only what the collection's API rules show a visitor, and only published records.",
      handler: async ({ records, schema }) => {
        // Each language's address for a record, so search engines get hreflang alternates.
        const languages = await schema.languages();
        const multilingual = languages.items.length > 1;
        const absolute = (href: string) => (/^https?:\/\//.test(href) ? href : origin + href);
        const entries: string[] = [];
        for (const slug of collections) {
          const byRecord = new Map<number, { lastmod?: string; addresses: Map<string, string> }>();
          for (const language of multilingual ? languages.items : [{ code: languages.defaultLocale }]) {
            // Only what's published in this language: a fallback isn't this language's page.
            const inLanguage = multilingual ? { locale: language.code, fallback: "none" } : {};
            for (let page = 1; page <= MAX_PAGES; page++) {
              const result = await records.list(slug, { page, perPage: PER_PAGE, filter: 'status = "published"', sort: "-id", fields: "id,updatedAt", urls: "1", ...inLanguage }).catch(() => null);
              if (!result) break;
              for (const item of result.items) {
                if (typeof item.recordPath !== "string" || typeof item.id !== "number") continue;
                const entry = byRecord.get(item.id) ?? { addresses: new Map<string, string>() };
                entry.addresses.set(language.code, absolute(languages.href(item.recordPath, language.code)));
                if (item.updatedAt && (!entry.lastmod || String(item.updatedAt) > entry.lastmod)) entry.lastmod = String(item.updatedAt);
                byRecord.set(item.id, entry);
              }
              if (page >= result.totalPages) break;
            }
          }
          for (const { lastmod, addresses } of byRecord.values()) {
            const alternates = multilingual && addresses.size > 1
              ? [...addresses].map(([code, href]) => `<xhtml:link rel="alternate" hreflang="${xml(code)}" href="${xml(href)}"/>`).join("") + (addresses.has(languages.defaultLocale) ? `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(addresses.get(languages.defaultLocale)!)}"/>` : "")
              : "";
            for (const href of addresses.values()) entries.push(`<url><loc>${xml(href)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ""}${alternates}</url>`);
          }
        }
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries.join("")}</urlset>\n`, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
      },
    })],
  });
}
