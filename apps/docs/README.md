# Tansy documentation site

The public documentation at `/docs`, plus the landing page. Built with
[Fumadocs](https://fumadocs.dev) on Next.js. It is not part of the repo's npm workspace: it has its
own `package.json` and lockfile, so the CMS's own install stays small.

```bash
npm run docs:sync    # from the repo root: rebuild the reference pages from docs/
npm run docs:dev     # http://localhost:3100
npm run docs:build
```

## Where the content comes from

| Pages | Source |
|---|---|
| `content/docs/extending.md`, `guides/`, `plugins/*.md`, `themes/*.md` | Generated from `docs/` in the repo root by `scripts/sync-docs.mjs` |
| `content/docs/index.mdx`, `getting-started/`, `plugins/index.mdx`, `plugins/community.mdx`, `themes/index.mdx` | Written by hand here |

The repo's `docs/` folder stays the single source for the reference pages: edit the markdown there,
then run `npm run docs:sync`. The script adds the frontmatter, turns links between the markdown
files into links between pages, and writes each section's `meta.json` for the sidebar order. It
never touches the hand-written pages. `prebuild` runs it, so a deploy always builds from current
markdown.

Sidebar order for a new guide, plugin or theme page goes in the `SECTIONS` table in
`scripts/sync-docs.mjs`; a page that isn't listed there is added at the end with a warning.

## The rest of the app

- `lib/shared.ts` — site name and the GitHub repo the "edit this page" links point at.
- `lib/layout.shared.tsx` — nav title and the top-level nav links.
- `lib/source.ts` — the content source and the LLM-facing routes.
- `app/(home)/page.tsx` — the landing page.
