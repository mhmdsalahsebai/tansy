# Dispatch theme (`@tansy/theme-dispatch`)

How themes work in general is in [Themes](../EXTENDING.md#themes) and [Write and publish a theme](../guides/themes.md).

A newsletter's site, for the [newsletter plugin](../plugins/newsletter.md) with the [blog plugin](../plugins/blog.md)'s posts as its issues: a masthead with the sign-up form, issues numbered newest first, an issue page made for reading that ends with the form again, and the newsletter's own page for confirming and unsubscribing. It follows the visitor's light or dark setting and works right to left.

```ts
// tansy.config.ts
import { blog as blogPlugin } from "@tansy/blog";
import { email } from "@tansy/email";
import { newsletter } from "@tansy/newsletter";
import { dispatch } from "@tansy/theme-dispatch";

export default defineCms({
  theme: dispatch({ tagline: "Notes on building things, every other Friday" }),
  plugins: [
    blogPlugin({ siteUrl: "https://example.com" }),
    email({ providers: [/* ... */] }),
    newsletter({ siteUrl: "https://example.com" }),
  ],
});
```

In the starter, `TANSY_THEME=dispatch` turns it on, and turns the newsletter and blog plugins on with it. Sending needs the site's email too (`TANSY_PLUGIN_EMAIL=true`). `TANSY_SITE_TAGLINE` sets `tagline`. Themes are chosen at build time, so set the same value for the build and the server, and restart after changing it.

## 1. Pages

| Address | Template | What it shows |
|---|---|---|
| `/` (with no record there) | `home` | The site's name, the tagline, the sign-up form, then the issues (12 a page), each with its number, title, excerpt, date and reading time |
| The blog's address, `/blog` by default | `blog-home` | The same page. Its heading and introduction come from the **Blog home** record |
| A post | `blog-posts` | The issue: title, excerpt as a lead, byline and date, cover, body and tags, then the sign-up form, more posts and comments |
| A category or tag | `blog-categories`, `blog-tags` | Its name and description, and its issues |
| The newsletter's page, `/newsletter` by default | `newsletter-page` | Its title and introduction, and the newsletter plugin's form: sign up, or confirm an address or unsubscribe from the links in its emails |
| Any other record, such as a page | `default` | Title and body |

Issue numbers count from the total number of published posts, so the newest is the highest and a post keeps its number from page to page. Archives aren't numbered.

The forms are the newsletter plugin's parts (`SignupForm`, `NewsletterManager`), and byline, tags, more posts and comments are the blog plugin's, so they behave exactly as on the plugins' own pages. Any post can be sent as a campaign from the dashboard, which is what makes it an issue in the subscribers' inboxes.

The header's **Subscribe** button goes to the newsletter's page, read from its URL pattern, so it follows the address the owner gives it. It is left out on that page itself.

## 2. Options

| Option | Default | What it does |
|---|---|---|
| `tagline` | none | Replaces the words under the front page's heading, and shows under the name in the footer |
| `showDates` | `true` | Dates on issues and on the issue page |
| `askName` | `false` | The sign-up forms ask for a name as well as the address |
| `colorScheme` | `"auto"` | `"auto"` follows the visitor's light or dark setting. `"light"` always shows light colours |

The theme's words are under `dispatch.*` and the forms' under `newsletter.*`. Owners can change any of them per language under Languages → Site text.

## 3. Content it uses

| Collection | Fields read |
|---|---|
| `blog-posts` | `title`, `excerpt`, `publishedAt`, `readingMinutes`, `cover`, `body`, `tags`, and what the blog plugin's parts read |
| `blog-home`, `blog-categories`, `blog-tags` | `title`, `intro`, `name`, `description`, `bio` |
| `newsletter-page` | `title`, `intro`, and its address |
| `site-menu` | `items`, a stream of **Menu item** blocks |

The theme's schema creates one collection, **Menu** (`site-menu`), as the blog and magazine themes do.

## 4. Styles

Plain CSS in `theme.css`, with no build step. Every colour, size and radius comes from the `--site-*` tokens, so the accent under Settings restyles the buttons, issue numbers and links. Headings use the `heading` font token, a system serif by default. Class names start with `dp-`, and the plugins' `nl-*` and `bl-*` parts are restyled only inside the theme's shell, so nothing reaches the dashboard.
