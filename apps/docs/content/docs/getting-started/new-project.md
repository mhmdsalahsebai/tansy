---
title: Start a new project
description: One command creates a Next.js app with the CMS, a site, and a database it has already migrated.
---

`create-tansy` makes a Next.js app with tansy already wired in: the dashboard, the API, a
site that renders a theme, and a `.env` with fresh secrets. It needs Node 22.18 or later.

```bash
npm create tansy@latest
```

In a terminal it asks what it needs to know, and pressing Enter at every question gives a site with
the blank theme on SQLite:

| Question | Choices |
|---|---|
| What are you making? | A site with the CMS in it, or a front end for a Tansy server you already run |
| Theme | Blank, Blog, Magazine, Dispatch, Storefront, Academy. Each turns on the plugins it renders |
| Where will it run? | This computer, a server you run, or Vercel and other serverless hosts |
| Database | SQLite, Postgres from a connection URL, or Postgres in Docker, started for you |
| Uploads | This server's disk, any S3-compatible service, or Vercel Blob |
| Features | Email through a provider, CAPTCHA, forms, analytics, social sign-in, an AI assistant, a breached-password check |
| Admin account | Create it now, or use the setup link the server prints on first start |

A serverless host has no lasting disk, so it isn't offered SQLite or local uploads. Providers'
keys aren't asked for: you set them later in the dashboard, or in the environment.

Then:

```bash
cd my-tansy
npm run dev
```

Unless you created the admin account while installing, the server log prints a one-time setup link
on first start. Open it to create the superadmin, then sign in. The admin is at `/dashboard`, the
API at `/api`, and your site's pages are in `app/(site)/`. Every plugin is a line in
`tansy.config.ts`, so remove the line to remove the feature.

## Without questions

Every question has a flag, and with `--yes`, or anywhere without a terminal such as CI, it asks
nothing and takes the defaults for whatever the flags leave out.

```bash
npm create tansy@latest my-site -- --yes
npm create tansy@latest my-shop -- --theme storefront --payments stripe --plugins email:resend,forms
npm create tansy@latest my-app -- --host serverless --database-url "$DATABASE_URL" --storage vercel-blob
npm create tansy@latest my-front -- --template headless --cms-url https://cms.example.com
```

| Flag | |
|---|---|
| `--template site\|headless` | `site` by default |
| `--theme <name>` | `blank`, `blog`, `magazine`, `dispatch`, `storefront` or `academy` |
| `--payments <provider>` | For the storefront theme: `stripe`, `polar`, `dodo`, `creem` or `commet` |
| `--host local\|server\|serverless` | Rules out what can't work there |
| `--database sqlite\|postgres\|docker` | `docker` writes `docker-compose.yml` and starts Postgres. Its password stays in `.env` |
| `--database-url <url>` | A `postgres://` URL, or a `file:` URL for SQLite |
| `--storage local\|s3\|vercel-blob` | S3 and Blob fall back to local disk until their settings are in `.env` |
| `--plugins <list>` | Comma-separated: `email`, `captcha`, `forms`, `analytics`, `social-sign-in`, `ai`, `pwned-passwords`. A provider follows a colon, as in `email:postmark` |
| `--admin-email <email>` | Creates the superadmin. Without a terminal, the password comes from `TANSY_ADMIN_PASSWORD` |
| `--cms-url <url>` | The server a headless front end reads |
| `--git`, `--no-git` | Start a repository with a first commit. Asked in a terminal, off otherwise |
| `--no-install` | Write the files and print the rest of the steps |

It installs with the package manager that ran it, so `pnpm create tansy` installs with pnpm.

## What to do next

- Model your content: [Content](/docs/guides/content).
- Put a site in front of it: [Themes](/docs/guides/themes).
- Add a feature: [Plugins](/docs/plugins).
- Before going live: [Running it](/docs/guides/operations) and [Backups](/docs/guides/backups).
