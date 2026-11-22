# Write and publish a theme

By the end you'll have a package on npm that sets the look of a tansy site. The full reference is in [Themes](../EXTENDING.md#themes).

## 1. Generate the theme

In a tansy site, or one you make with `npx create-tansy my-site`:

```sh
npx tansy theme new acme --package @your-scope/cms-theme-acme
```

This writes `themes/acme`:

| File | What it's for |
|---|---|
| `index.ts` | The manifest: name, tokens, and what each page needs. No React, so `tansy.config.ts` can import it |
| `render.tsx` | Templates and layouts, as server components |
| `theme.css` | Your styles, using `--site-*` variables |

## 2. Turn it on

```sh
npm install ./themes/acme
```

In `tansy.config.ts`, replace the `theme` line:

```ts
import { acmeTheme } from "@your-scope/cms-theme-acme";

export default defineCms({
  theme: acmeTheme(),
  // ...what was already here
});
```

Run `npm run dev` and open `/`. If your app has no site pages yet, run `npx tansy init --site` first.

## 3. Set the look

Each token in `index.ts` becomes a `--site-<group>-<name>` variable, such as `--site-color-accent`. The groups are `color`, `font`, `space`, `radius`, `size` and `shadow`. A value that doesn't suit its group fails the build, and the accent colour under Settings overrides `color.accent`.

## 4. Add a template

Templates are picked by collection slug, then `default`, and `home` renders the root when no record lives there. To give a `posts` collection its own page, add this to `render.tsx`:

```tsx
function Post({ record, stream }: TemplateProps) {
  if (!record) return null;
  return <article><h1>{String(record.title)}</h1><StreamField blocks={record.body} {...stream} /></article>;
}

export default defineThemeComponents({ templates: { home: Home, posts: Post, default: Page }, layouts: { default: Layout } });
```

The collection needs a URL pattern, set under its schema, before its records have addresses. Spreading `stream` means blocks use your components first, then plugins' defaults.

## 5. Load lists

A template declares its lists in the manifest, and receives them as `data`:

```ts
queries: { home: { posts: { collection: "posts", sort: "-publishedAt", perPage: 20 } } },
```

Reads run as a signed-out visitor, so the collection's API rules decide what appears. A collection that doesn't let visitors list it renders as an empty list.

A query that depends on who is looking, such as "my progress", sets `viewer: true`. It then reads as the signed-in person, under API rules alone: `{ collection: "lms-progress", filter: "course = @record.id", viewer: true }` returns their own rows where the rule is `student = @request.auth.id`. Signed out, it reads as a visitor. Their role's permissions never apply, so staff get only their own rows too, and these reads are never cached.

An address whose record visitors can't see, but the signed-in person can, such as a lesson in a course they joined, renders for them in the same way: the record, its `expand` and its `viewer` queries are read as them. Everyone else gets the not-found page. See the site layer in the security model.

To page a list, mark its query `paged: true` and put a pager under it. `?page=2` then reads the second page, and a number past the last page shows the not-found page:

```tsx
import { Pager } from "tansy/react";

<Pager list={data.posts} path={path} />
```

A filter can use fields of the page's record. On a post's page, this lists other posts that share a tag:

```ts
related: { collection: "posts", filter: "tags ?= @record.tags && id != @record.id", perPage: 3 },
```

## 6. Redesign a plugin's page

A plugin such as the blog renders pages for its own collections. Give your theme a template with the same name to design one yourself. It receives the plugin's lists for that page as `data`, and the plugin exports the parts with behaviour, so you place them rather than rebuild them:

```tsx
import { MorePosts, PostComments, PostMeta, PostTags } from "@tansy/blog/render";

function Post({ record, data, stream }: TemplateProps) {
  if (!record) return null;
  return (
    <article>
      <h1>{String(record.title)}</h1>
      <PostMeta post={record} data={data} />
      <StreamField blocks={record.body} {...stream} />
      <PostTags post={record} data={data} />
      <MorePosts post={record} data={data} />
      <PostComments post={record} data={data} />
    </article>
  );
}

export default defineThemeComponents({ templates: { "blog-posts": Post, /* ... */ } });
```

The parts bring no outer margin or border, so place them with your own layout. Their headings follow your outline: `headingLevel` sets their level, and `heading={false}` hides one when your own section already has a title, as the [blog plugin](../plugins/blog.md#8-site-pages) describes.

Add the plugin to `requires.plugins` in the manifest, so a site without it fails at startup with a clear message. `themes/blog` does exactly this, and [`themes/magazine`](../themes/magazine.md) goes further: it redesigns every blog page, and replaces the plugin's `posts` list on archives with one that also reads covers, by giving its own query the same name.

## 7. Publish it

Check `name` and `version` in `package.json`, and add a `license`. Raise `version` in `index.ts` to match when you release. Keep the `tansy-theme` keyword: it's how the dashboard's list of community packages finds yours.

```sh
cd themes/acme
npm publish --access public
```

## 8. Install it somewhere else

```sh
npm install @your-scope/cms-theme-acme
```

Add the same import and `theme` line, then rebuild. The same package works on a headless site. See [Headless](../EXTENDING.md#headless), or start from `npx create-tansy --template headless`.

## Several themes in one build

A site owner can install more than one theme and let each site choose. `themes` takes a list, the first being the default:

```ts
import { acmeTheme } from "@your-scope/cms-theme-acme";
import { blank } from "@tansy/theme-blank";

export default defineCms({
  themes: [blank(), acmeTheme()],
  // ...what was already here
});
```

Set `theme` for one theme or `themes` for several, never both: with both, nothing would say which is the default. Every theme in the list is checked at startup, so a theme that needs a plugin the site doesn't have fails the build rather than the page, and each one's `schema` is applied the way a single theme's is.

With a scope provider such as [the multi-tenant plugin](../plugins/multi-tenant.md), **Site** then shows a **Theme** field beside the site's name and colour, and that tenant's pages are served in the theme it picked. A site that picks nothing, and the instance's own pages, use the default. The themes themselves come with the build, so adding one means a rebuild; choosing among them doesn't, and anyone with `setting:site` in that tenant can do it.

What a theme is doesn't change: the same package serves one site or many, and a template gets the same props either way. Two limits are worth knowing:

- **A theme's `options` are set in `tansy.config.ts`, so they're the same for every site.** A tenant picks the theme, not its options.
- **The block editor's canvas shows blocks in the default theme**, there being one editor for the instance. The site itself is served in the theme it chose.

## Before you publish

- A theme's `schema` creates collections and blocks that don't exist yet, and a new version adds the fields an existing collection is missing. It never changes or removes anything, and never brings back what an owner deleted. Make fields you add later optional, and handle a field an owner may have removed.
- Load fonts with `next/font/local` in `render.tsx`, because the Content Security Policy only allows fonts from the site itself.
- `options` reach headless sites, so never put a secret in one.
