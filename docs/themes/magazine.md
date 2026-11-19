# Magazine theme (`@tansy/theme-magazine`)

How themes work in general is in [Themes](../EXTENDING.md#themes) and [Write and publish a theme](../guides/themes.md).

A magazine look for the [blog plugin](../plugins/blog.md): a hero with a search box, posts as image cards, a sidebar of featured and latest posts, a long-form post page, and category and tag pages in the same style. It follows the visitor's light or dark setting, works right to left, and needs no JavaScript except for search.

```ts
// tansy.config.ts
import { blog } from "@tansy/blog";
import { magazine } from "@tansy/theme-magazine";

export default defineCms({
  theme: magazine({ tagline: "Notes from the team" }),
  plugins: [blog({ siteUrl: "https://example.com" })],
});
```

In the starter, `TANSY_THEME=magazine` turns it on, and turns the blog plugin on with it. `TANSY_SITE_TAGLINE` sets `tagline`. Themes are chosen at build time, so set the same value for the build and the server, and restart after changing it.

## 1. Pages

| Address | Template | What it shows |
|---|---|---|
| `/` (with no record there) | `home` | Hero, search, posts as cards (9 a page), Featured and Latest in the sidebar |
| The blog's address, `/blog` by default | `blog-home` | The same page. Its heading and introduction come from the **Blog home** record |
| A post | `blog-posts` | Categories, title, excerpt, byline and date, cover, body, tags, three related posts as cards, comments |
| A category or tag | `blog-categories`, `blog-tags` | Its name and description, its posts as cards with paging, Latest in the sidebar |
| Any other record, such as a page | `default` | Title and body in the reading column |

The theme's templates replace the blog plugin's for the same collections. The post page is built from the plugin's exported parts (`PostMeta`, `PostTags`, `PostComments`), so bylines, tag links and comment moderation behave exactly as on the plugin's own page. The plugin's blocks (text, image, quote, code, embed, callout) render with the plugin's components and the theme's styles.

Related posts are those sharing a tag with the post. When none do, the newest posts take their place. Featured posts are the ones with **Featured** ticked.

## 2. Options

| Option | Default | What it does |
|---|---|---|
| `tagline` | none | Replaces the words under the home page's heading, and shows under the name in the footer |
| `showDates` | `true` | Dates on cards, in the sidebar, in search results and on posts |
| `accountLinks` | `true` | **Sign in** and **Register** buttons in the header. Turn off when visitors have no accounts |
| `search` | `true` | The search box on the home page |
| `colorScheme` | `"auto"` | `"auto"` follows the visitor's light or dark setting. `"light"` always shows light colours |

Options are checked at startup and reach headless sites, so they never hold anything secret.

## 3. Content it uses

| Collection | Fields read |
|---|---|
| `blog-posts` | `title`, `excerpt`, `cover`, `categories`, `tags`, `featured`, `readingMinutes`, `byline`, `publishedAt`, `body`, `allowComments` |
| `blog-categories`, `blog-tags` | `name`, `description` |
| `blog-home` | `title`, `intro` |
| `site-menu` | `items`, a stream of **Menu item** blocks |

Every field is optional to the theme: a post with no cover gets a card filled with the accent colour, and a post with no category gets no pill. If an owner removes a field, the theme leaves out what it showed.

The theme's schema creates one collection, **Menu** (`site-menu`), a singleton read on every page. It is created the first time the server starts with the theme, so restart after turning it on. Its items are the header menu, and the footer's links. An item with children opens as a dropdown on hover or keyboard focus, and in the menu button's panel on small screens.

Every list is read as a signed-out visitor, so the collections' API rules decide what appears. Drafts never show.

## 4. Search

The search box looks up published posts as the visitor types, through `GET /api/collections/blog-posts/records?search=…`, which matches the posts collection's searchable fields (title and excerpt by default). It reads as whoever is looking, under the collection's list rule, and asks only for `status = "published"`, so staff see the results visitors see. On a site with more than one language it searches in the page's language.

Results come from the CMS's own search, or from Meilisearch, Typesense or Algolia when one is set, with nothing to configure in the theme.

## 5. Look

Every colour, size and radius is a token in `index.ts`, used in `theme.css` as a `--site-*` variable:

| Token | Default | Used for |
|---|---|---|
| `color.page` / `surface` | `#ffffff` / `#f5f7fa` | Background, and quiet panels such as the footer |
| `color.text` / `muted` / `border` | `#101828` / `#5d6779` / `#e6e9ef` | Text, secondary text, hairlines |
| `color.accent` / `on-accent` | `#2563eb` / `#ffffff` | Buttons, links, focus rings, the hero's wash, cards with no cover |
| `size.measure` / `wide` | `44rem` / `76rem` | The reading column, and the page |
| `space.gutter` / `gap` / `section` | `1.25rem` / `1.5rem` / `4rem` | Page edges, between cards, between sections |
| `radius.card` / `control` | `1rem` / `0.625rem` | Cards and images, buttons and fields |
| `shadow.card` | a soft drop shadow | Raised cards, menus and search results |

The accent under **Settings** overrides `color.accent`, and the softer and stronger shades of it are mixed from whatever it is. Dark mode replaces the neutral colours only, so the accent stays the owner's.

The font is Geist, served from the site itself as the Content Security Policy requires (see `fonts/README.md` for its licence). Class names start with `mg-`, so the stylesheet touches nothing outside the theme's pages.

## 6. Words

The theme's words are under `magazine` in `render.tsx`, in English and Arabic: the hero's heading and introduction, search, section headings, paging, account buttons and the footer. Owners change any of them per language under **Languages → Site text**, for example `magazine.heroTitle`. The blog's own words, such as `blog.minutes`, come from the plugin.

On a site with more than one language, every link stays in the page's language, the header shows a language switcher, and right-to-left languages are laid out mirrored.

## 7. Accessibility

- A **Skip to content** link is the first stop for the keyboard.
- Each card is one link, its title, which covers the whole card. The category pill is a separate link above it.
- The menu opens with the keyboard as well as the pointer, and the small-screen menu is a native disclosure that works without JavaScript.
- Search announces how many posts it found through a polite live region, and Escape clears it.
- Focus rings use the accent. Hover movement is turned off for visitors who ask for reduced motion.
- Decorative images have empty `alt`, since each card's title already names it.

## 8. Files

| File | What it holds |
|---|---|
| `index.ts` | The manifest: options, tokens, the queries each template needs, `requires: { plugins: ["blog"] }` |
| `render.tsx` | Layout, templates, words and page metadata, as server components |
| `search.tsx` | The search box, the theme's one client component |
| `theme.css` | All styles |
| `schema.json` | The Menu singleton |
| `fonts/` | Geist |

To make your own version, copy `themes/magazine`, rename the package and the theme's `name`, and follow [Write and publish a theme](../guides/themes.md).
