---
title: Run from source
description: Clone the repository and run the CMS and its starter app from the workspace, for contributing or for reading the code.
---

Running from source is for working on Tansy itself. To build a site, start from
[a new project](/docs/getting-started/new-project) instead.

Requires Node 24. SQLite is the default database, and any Postgres works through `DATABASE_URL`.

```bash
npm install
npm run tansy -- init       # writes .env with new secrets
npm run tansy -- migrate
npm run dev
```

On first start the server log prints a one-time setup link. Open it to create the superadmin.

## The workspace

| Folder | What is in it |
|---|---|
| `packages/cms` | The CMS: core, components, API routes, dashboard, Prisma schema, CLI |
| `packages/create-tansy` | The `create-tansy` command |
| `apps/starter` | The app the CMS is developed against: entry files and `tansy.config.ts` only |
| `apps/docs` | This documentation site |
| `plugins/*` | The first-party plugins and their provider adapters |
| `themes/*` | The themes that ship |
| `examples/*` | Small, single-purpose extensions used as worked examples |
| `docs/` | The markdown these pages are built from |

## Checks

```bash
npm run check             # type-check, lint, unit and contract tests
```

```bash
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:integration   # wipes that file
```

```bash
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:package       # the same suite, against the tarball in a fresh app
```

`npm run check` has to pass before a change is done. The integration suite is the end-to-end
security suite and needs a disposable database whose name contains `test` or `smoke`.

## The docs site

These pages are built from the repo's own markdown. After editing anything under `docs/`:

```bash
npm run docs:sync         # regenerate the reference pages
npm run docs:dev          # the site at http://localhost:3000
```
