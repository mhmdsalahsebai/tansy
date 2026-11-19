---
title: Start a new project
description: One command creates a Next.js app with the CMS, a site, and a database it has already migrated.
---

`create-tansy` makes a Next.js app with tansy already wired in: the dashboard, the API, a
site that renders a theme, and a `.env` with fresh secrets. It needs Node 22.18 or later.

```bash
npx create-tansy my-site                       # the CMS and a site in one app
npx create-tansy my-blog --template blog       # the same, with a blog theme
npx create-tansy my-front --template headless  # a front end for a CMS running elsewhere
```

Then:

```bash
cd my-site
npm run dev
```

The server log prints a one-time setup link on first start. Open it to create the superadmin, then
sign in. The admin is at `/dashboard`, the API at `/api`, and your site's pages are in `app/(site)/`.

## The templates

| Template | What it gives you |
|---|---|
| `blank` (default) | The CMS, and a site page rendering the blank theme, ready to build on |
| `blog` | The same, with the Blog plugin and the blog theme turned on |
| `headless` | A Next.js front end that renders a theme over the API of a CMS running elsewhere |

## What to do next

- Model your content: [Content](/docs/guides/content).
- Put a site in front of it: [Themes](/docs/guides/themes).
- Add a feature: [Plugins](/docs/plugins).
- Before going live: [Running it](/docs/guides/operations) and [Backups](/docs/guides/backups).
