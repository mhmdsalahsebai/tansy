# SEO plugin (`@tansy/seo`)

Two field types for what search results show, and a `sitemap.xml` built from your collections' own
URL patterns.

```ts
// tansy.config.ts
import { seo } from "@tansy/seo";

plugins: [seo({ siteUrl: "https://example.com", collections: ["posts", "pages"] })]
```

| Option | |
|---|---|
| `siteUrl` | The public site's origin. Addresses in the sitemap are made absolute against it |
| `collections` | The slugs to list in the sitemap. Each needs a URL pattern, or it has no addresses to list |

## 1. The fields

Add **SEO title** and **SEO description** to a collection's schema wherever you want them, the way
you would any other field type.

| Field type | Stored as | Limit |
|---|---|---|
| `seo_title` | text | 70 characters |
| `seo_description` | text | 160 characters |

The lengths are the ones search engines actually show, so the editor refuses a value that would be
cut off rather than letting it look fine in the form and wrong in the results.

Core's site layer already reads these names when it builds a page's `<head>`: the title falls back
from `seo_title` to `title` to the site's name, and the description from `seo_description` to
`summary`. A theme can override either in its own `metadata()`. So installing this plugin and
adding the fields is all a page's title and description need — no theme change.

For the collections listed in the options, `record.beforeCreate` fills an empty **SEO title** from
the record's `title`, cut to 70 characters, so a new record starts with something sensible. It only
fills what is empty, and only on create.

Both field types' names are translated: the plugin ships English and Arabic for them.

## 2. The sitemap

`GET /sitemap.xml` at the root of the site, public, cached for five minutes.

- It lists **only published records**, and only what the collection's own API rules show a
  signed-out visitor. A record nobody may read is not in it.
- Each record contributes its address from its URL pattern, with `<lastmod>` from `updatedAt`.
- On a multilingual site, each language is listed under its own address, with
  `<xhtml:link rel="alternate" hreflang="…">` for every language the record is published in and
  `x-default` for the default one. A fallback is not that language's page, so a record not published
  in a language is not listed under it.
- At most 50 pages of 200 records per collection, so a very large site needs its own sitemap route
  or an index.

`hreflang` in a page's `<head>` is core's, not this plugin's: it comes from the page's alternates
whenever a site has more than one language, whether or not this plugin is installed.

## 3. Limits to know

- No `robots.txt`. Next.js writes one from `app/robots.ts` in a few lines, and what belongs in it is
  a site's decision rather than a plugin's.
- No Open Graph or Twitter card tags of its own. A page's title and description are set, and a
  theme's `metadata()` adds anything else it wants.
- No canonical link, no redirect management (that is core's **Dashboard → Redirects**), and no
  structured data.
- No per-record "no index" switch, and nothing that reads or reports search-engine rankings.
- A collection without a URL pattern has no addresses, so listing it in `collections` adds nothing.
