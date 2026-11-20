# Halo theme (`@tansy/theme-halo`)

How themes work in general is in [Themes](../EXTENDING.md#themes) and [Write and publish a theme](../guides/themes.md).

A news front page for the [blog plugin](../plugins/blog.md): a lead story beside a Recommended panel, the latest news beside a spotlight story, a trending block, readers' choice and a carousel of popular stories, on quiet panels over a pale page. Editors choose what each section shows on a **Front page** record; whatever they leave empty fills itself from featured and recent posts. It follows the visitor's light or dark setting and works right to left.

```ts
// tansy.config.ts
import { blog } from "@tansy/blog";
import { halo } from "@tansy/theme-halo";

export default defineCms({
  theme: halo({ tagline: "Markets, made readable" }),
  plugins: [blog({ siteUrl: "https://example.com" })],
});
```

In the starter, `TANSY_THEME=halo` turns it on, and turns the blog plugin on with it. `TANSY_SITE_TAGLINE` sets `tagline`. Themes are chosen at build time, so set the same value for the build and the server, and restart after changing it.

## 1. Pages

| Address | Template | What it shows |
|---|---|---|
| `/` | `halo-front`, or `home` until the Front page record exists | Best of the week, Recommended, Latest news, the spotlight, Trending now, Readers' choice, Popular news |
| The blog's address, `/blog` by default | `blog-home` | The newest story of the page leading, the next six as cards, arrows to older pages. Its heading and introduction come from the **Blog home** record |
| A category or tag | `blog-categories`, `blog-tags` | The same layout, with the category's or tag's name and description |
| A post | `blog-posts` | Category and time, title, excerpt, byline, cover, body, tags, comments, Recommended beside it, and four related stories under it |
| Any other record, such as a page | `default` | Title and body in the reading column |

The post page is built from the blog plugin's exported parts (`PostMeta`, `PostTags`, `PostComments`), so bylines, tag links and comment moderation behave exactly as on the plugin's own page. The plugin's blocks render with the plugin's components and the theme's styles.

## 2. The front page

The theme's schema creates a singleton, **Front page** (`halo-front`), whose address is `/`. Each of its fields picks stories for one section, in the order chosen:

| Field | Section | Up to | When empty |
|---|---|---|---|
| `lead` | Best of the week, the large headline | 1 | The newest featured post, else the newest post |
| `spotlight` | The large story beside Latest news | 1 | The next featured post, else the next newest |
| `recommended` | The Recommended panel: a feature card, then rows | 5 | Recent posts |
| `trending` | Trending now: the first leads, the rest are cards | 7 | Recent posts |
| `readersChoice` | Readers' choice: a large feature, then two columns of rows | 9 | Featured, then recent posts |
| `popular` | Popular news, a carousel | 10 | Recent posts |
| `title` | The page's title, for search engines and the browser tab | | The site's name |

**Latest news** always shows the four newest posts no other section has taken, and the three stories under the lead are the next featured posts. Sections that fill themselves never repeat a story an earlier section showed, except Trending, Readers' choice and Popular, which reuse stories rather than stay empty on a site with only a few posts. A section with nothing to show is left out.

Until someone creates and publishes the Front page record, `/` renders the same page entirely from featured and recent posts. Nothing has to be set up for the site to look complete. There is no view counter behind "Trending" or "Popular": those are editorial picks, or recent posts when nobody picked.

The record is read like any other: the collection's rules let visitors view it, and only staff with `record:*` on it can change it, which an owner can widen to the blog editor role under **Roles**.

## 3. Options

| Option | Default | What it does |
|---|---|---|
| `tagline` | none | Shows under the name in the footer |
| `showDates` | `true` | Times on stories, in search results and on posts |
| `relativeDates` | `true` | "4 hours ago" for the last week, in the visitor's browser. The page itself carries the date, so cached and script-free pages stay correct |
| `accountLinks` | `true` | **Sign in** and **Register** in the header. Turn off when visitors have no accounts |
| `search` | `true` | The search field in the header |
| `colorScheme` | `"auto"` | `"auto"` follows the visitor's light or dark setting. `"light"` always shows light colours |

Options are checked at startup and reach headless sites, so they never hold anything secret.

## 4. Content it uses

| Collection | Fields read |
|---|---|
| `blog-posts` | `title`, `excerpt`, `cover`, `categories`, `tags`, `featured`, `readingMinutes`, `byline`, `publishedAt`, `body`, `allowComments` |
| `blog-categories`, `blog-tags` | `name`, `description` |
| `blog-home` | `title`, `intro`, and its address for every **View more** link |
| `halo-front` | the fields in §2 |
| `site-menu` | `items`, a stream of **Menu item** blocks |

Every field is optional to the theme: a story with no cover gets a lavender placeholder, one with no category shows only its time, and one with no tags shows none. If an owner removes a field, the theme leaves out what it showed. The schema is applied the first time the server starts with the theme, so restart after turning it on.

The **Menu** is the header's row of chips and the footer's links. An item with children shows a **+** and opens on hover or keyboard focus, and in the menu button's panel on small screens.

Every list is read as a signed-out visitor, so the collections' API rules decide what appears. Drafts never show.

## 5. Search

The header's field looks up published posts as the visitor types, through `GET /api/collections/blog-posts/records?search=…`, which matches the posts collection's searchable fields. It reads as whoever is looking, under the collection's list rule, and asks only for `status = "published"`. On a site with more than one language it searches in the page's language. Results come from the CMS's own search, or from Meilisearch, Typesense or Algolia when one is set.

## 6. Look

The design decisions, with each token's role, are in `themes/halo/DESIGN.md`. Every colour, size and radius is a token in `index.ts`, used in `theme.css` as a `--site-*` variable:

| Token | Default | Used for |
|---|---|---|
| `color.page` / `panel` / `surface` | `#eef1f8` / `#ffffff` / `#e9edf6` | The page, the panels on it, chips and fields |
| `color.text` / `muted` / `border` | `#0e1020` / `#5d6478` / `#e1e5ef` | Text, times and tags, hairlines |
| `color.accent` / `on-accent` | `#3450d1` / `#ffffff` | Category names, links, focus rings |
| `color.glow` | `#a995ff` | The halo, section markers, the wash over feature images |
| `color.ink` | `#10111a` | The solid buttons: next, Register |
| `size.wide` / `aside` / `measure` | `86rem` / `22rem` / `42rem` | The page, side panels, the reading column |
| `space.gutter` / `gap` / `section` | `1rem` / `1rem` / `3.5rem` | Page edges, between panels, between sections |
| `radius.panel` / `card` / `control` / `field` | `1.5rem` / `0.875rem` / `999px` / `0.875rem` | Panels, images, pills and circles, the search field |
| `shadow.float` | a soft lavender drop | Only what floats: menus, search results, the badge |

The accent under **Settings** overrides `color.accent`, and the halo and soft shades mix from it. Dark mode replaces the neutral colours only.

The font is Geist, served from the site itself as the Content Security Policy requires (see `fonts/README.md` for its licence). Class names start with `ha-`, so the stylesheet touches nothing outside the theme's pages. The theme is plain CSS: Tailwind's reset would reach the dashboard, and a theme compiled with it has to ship its own build, as `themes/storefront` does.

## 7. Words

The theme's words are under `halo` in `render.tsx`, in English and Arabic: section labels, buttons, search, paging and the footer. Owners change any of them per language under **Languages → Site text**, for example `halo.trending`. The blog's own words, such as `blog.category`, come from the plugin.

## 8. Accessibility

- A **Skip to content** link is the first stop for the keyboard. The front page has a heading for screen readers, the Front page record's title or the site's name.
- Each story is one link, its title, which covers the card. The category and tags are separate links above it.
- The carousel is a scrollable region the keyboard can reach. Its buttons only move it further, and it scrolls by touch or trackpad without script.
- Pager arrows have names ("Newer stories", "Older stories"), and an end it can't go past isn't a link.
- Search announces how many articles it found through a polite live region, and Escape clears it.
- Hover movement and smooth scrolling are turned off for visitors who ask for reduced motion.

## 9. Files

| File | What it holds |
|---|---|
| `index.ts` | The manifest: options, tokens, the queries each template needs, `requires: { plugins: ["blog"] }` |
| `render.tsx` | Layout, templates, words and page metadata, as server components |
| `client.tsx` | Search, the carousel and relative times, the theme's client components |
| `theme.css` | All styles |
| `schema.json` | The Menu and Front page singletons |
| `DESIGN.md` | The design decisions behind the tokens |
| `fonts/` | Geist |
