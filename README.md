<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mhmdsalahsebai/tansy/main/apps/docs/public/brand/logo-light.png">
    <img src="https://raw.githubusercontent.com/mhmdsalahsebai/tansy/main/apps/docs/public/brand/logo-dark.png" alt="Tansy" height="64">
  </picture>
</h1>

**A self-hosted CMS for Next.js where collections, fields and access rules are defined in the dashboard, so they change without a deploy.**

[![npm](https://img.shields.io/npm/v/tansy)](https://www.npmjs.com/package/tansy)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/mhmdsalahsebai/tansy/blob/main/LICENSE)

[Documentation](https://tansycms.vercel.app) · [Live demo](https://tansy-demo-shop.netlify.app) · [Plugins](https://tansycms.vercel.app/docs/plugins) · [Changelog](https://github.com/mhmdsalahsebai/tansy/blob/main/CHANGELOG.md)

```bash
npm create tansy@latest
```

> **Beta.** Tansy is pre-1.0 and under active development. Any release can change anything — package
> names, commands, configuration keys, environment variables, database columns — in a patch release
> and without a deprecation period. Pin exact versions, read the [changelog](https://github.com/mhmdsalahsebai/tansy/blob/main/CHANGELOG.md) before
> every upgrade, and take a [backup](https://tansycms.vercel.app/docs/guides/backups) first. The compatibility promises in
> [upgrading](https://tansycms.vercel.app/docs/guides/upgrading) start at 1.0.

## Why Tansy

- **The schema lives in the database.** Editors add collections, fields and blocks from the dashboard while the site keeps serving. Export it as JSON when you want it in git.
- **One access model for everything.** Roles, permissions and per-collection rules decide what the REST API, realtime, the SDK, MCP and your theme may read or write, through the same check.
- **It runs inside your Next.js app.** `npm install tansy` and `tansy init` add the dashboard at `/dashboard` and the API at `/api` beside your own routes. Or run it headless and read it over HTTP.
- **SQLite or Postgres, your server or serverless.** One file to start. Every migration ships for both databases.
- **Features are plugins, and plugins use only public extension points.** The blog, shop and courses are built on the same API you get, so yours can do what they do.

## Try the demo

A live bookstore built on the published packages: the storefront theme, the shop, payments and
subscriptions plugins, in English and Arabic.

- **The shop:** <https://tansy-demo-shop.netlify.app>. Browse, add books to the cart and check out
  with Stripe's test card `4242 4242 4242 4242`, or join the Readers' Club at `/library`.
- **The dashboard:** <https://tansy-demo-shop.netlify.app/dashboard>

| Email | Password |
| --- | --- |
| `demo@example.com` | `explore-tansy-shop` |

The demo account is shared by everyone. Edit books and prices, add a category, ship and deliver
orders, translate a page: the demo is put back as it was every hour, so change whatever you like. It
can't touch users, roles, settings, webhooks or API keys, or change its own password. To keep what
you build, run your own copy with `npm create tansy@latest`, which takes a minute.

## Features

**Content**

- Collections, fields and URL patterns defined at runtime, plus singletons and read-only view collections built from SQL.
- A block editor: stream fields made of blocks you define in the dashboard or ship in a plugin.
- Drafts, scheduled publishing, revisions with a diff, a review step before publishing, and a trash you can restore from.
- A media library on local disk, S3 or any S3-compatible service, Cloudinary, Bunny, Vercel Blob or Uploadthing, with focal points and alternative text.
- CSV and JSON import, and the whole schema exported or imported as JSON.
- Search in the database, or in [Meilisearch, Typesense or Algolia](https://tansycms.vercel.app/docs/guides/search), kept in step by a queue that retries.

**Access and sign-in**

- Users, roles and permissions managed from the dashboard, built on [better-auth](https://www.better-auth.com).
- Password, passkeys, magic links and email codes, authenticator-app MFA that can be required for the dashboard, and OAuth through `@tansy/social-sign-in`.
- Per-collection rules in one filter language, such as `status = "published" || owner = @request.auth.id`, compiled to SQL where they can be.
- Custom user fields that rules read, API keys with their own permissions, and an audit log of every write.

**APIs**

- REST with filters, sorting and relation expansion, `POST /api/batch`, and an OpenAPI 3.1 description.
- Realtime subscriptions, under the same rules as reads.
- A typed TypeScript SDK (`tansy/sdk`) with types generated from your schema by `tansy types`.
- Signed webhooks with retries.
- An MCP server at `/api/mcp`, so an AI agent can read and write content with an API key's permissions.

**Languages**

- Records translated per field, each language published on its own, with a fallback chain.
- An address per language (`/fr/...` or a domain per language), `hreflang`, and right-to-left pages.
- Translators limited to their own language, XLIFF export and import, and machine translation through a plugin.
- The dashboard in English and Arabic.

**Running it**

- `tansy backup` and `tansy restore`: one encrypted archive of the database and uploads, by hand or on a schedule.
- Background work (scheduled publishing, webhooks, the search queue, plugins' jobs) kept in the database, on a server or serverless.
- Health and readiness checks, Prometheus metrics, and `tansy doctor` to check an install.
- A Docker image and a `docker compose` file for Postgres.

**Extending it**

- [Plugins](https://tansycms.vercel.app/docs/guides/plugins) add collections, field types, blocks, permissions, routes, jobs, dashboard pages and agent tools.
- [Hook files](https://tansycms.vercel.app/docs/extending) in `cms_hooks/` add record hooks, routes and jobs without a rebuild.
- [Themes](https://tansycms.vercel.app/docs/guides/themes) render the public site, in the same app or headless over the API.
- `tansy plugin new`, `tansy field new` and `tansy theme new` scaffold each of them.

Before you commit to it, [limits](https://tansycms.vercel.app/docs/guides/limits) lists every boundary in one place.

## Official plugins

| Package | What it adds |
| --- | --- |
| [`@tansy/blog`](https://tansycms.vercel.app/docs/plugins/blog) | Posts, categories, tags, authors, comments and feeds |
| [`@tansy/shop`](https://tansycms.vercel.app/docs/plugins/shop) | Products, variants, stock, a cart, shipping zones, orders and fulfilment |
| [`@tansy/payments`](https://tansycms.vercel.app/docs/plugins/payments) | Subscriptions and one-time purchases through better-auth's payment plugins: Stripe, Polar, Dodo Payments, Creem and Commet |
| [`@tansy/subscriptions`](https://tansycms.vercel.app/docs/plugins/subscriptions) | Plans, what each one opens, and who is on which plan, in one section of the dashboard |
| [`@tansy/lms`](https://tansycms.vercel.app/docs/plugins/lms) | Courses, lessons, enrollments, progress, quizzes and verifiable certificates, free or paid |
| [`@tansy/newsletter`](https://tansycms.vercel.app/docs/plugins/newsletter) | Double opt-in subscribers, one-click unsubscribe, and campaigns sent in batches, including any post |
| [`@tansy/forms`](https://tansycms.vercel.app/docs/plugins/forms) | Contact and other forms built from blocks, kept as submissions, emailed, and guarded against spam |
| [`@tansy/ai`](https://tansycms.vercel.app/docs/plugins/ai) | An assistant on the Vercel AI SDK that creates and edits content and fills forms. OpenAI, Anthropic, Google, Mistral, xAI, Groq, DeepSeek, OpenRouter, Vercel AI Gateway, OpenCode, Command Code, or any OpenAI-compatible server |
| [`@tansy/analytics`](https://tansycms.vercel.app/docs/plugins/analytics) | Cookie-free page views counted by the CMS, or sent to Plausible, Umami, Google Analytics, Fathom or Matomo, with the numbers on the dashboard |
| [`@tansy/seo`](https://tansycms.vercel.app/docs/plugins/seo) | Search-engine fields and a sitemap built from each collection's URL pattern |
| [`@tansy/email`](https://tansycms.vercel.app/docs/plugins/email) | Email through Resend, Postmark, SendGrid, Mailgun, Amazon SES or Brevo instead of SMTP, with a delivery log |
| [`@tansy/social-sign-in`](https://tansycms.vercel.app/docs/plugins/social-sign-in) | Google, GitHub and other OAuth providers, each configured on the dashboard |
| [`@tansy/captcha`](https://tansycms.vercel.app/docs/plugins/captcha) | Cloudflare Turnstile, hCaptcha or reCAPTCHA on sign-in and on plugins' forms |
| [`@tansy/pwned-passwords`](https://tansycms.vercel.app/docs/plugins/pwned-passwords) | Refuses passwords found in known breaches, checked by hash range |
| [`@tansy/multi-tenant`](https://tansycms.vercel.app/docs/plugins/multi-tenant) | Many sites or customers in one instance, each with its own members, roles, domains, content, files and limits |
| [`@tansy/request-logs`](https://tansycms.vercel.app/docs/plugins/request-logs) | A log of every API request, on the dashboard and sent to storage, an HTTP drain or the console |
| [`@tansy/logs-otlp`](https://tansycms.vercel.app/docs/plugins/logs-otlp) | The audit and request logs over OpenTelemetry, to Grafana, Honeycomb, Datadog, Axiom or any collector |

Each provider is a package of its own, such as `@tansy/payments-stripe` or `@tansy/ai-anthropic`, so a site installs only the ones it uses.

## Official themes

| Package | For |
| --- | --- |
| [`@tansy/theme-blank`](https://tansycms.vercel.app/docs/guides/themes) | The smallest theme that works, made to be copied |
| [`@tansy/theme-blog`](https://tansycms.vercel.app/docs/guides/themes) | A blog: a menu, posts on the home page, post pages and plain pages |
| [`@tansy/theme-magazine`](https://tansycms.vercel.app/docs/themes/magazine) | A magazine: a hero with search, image cards and a sidebar |
| [`@tansy/theme-halo`](https://tansycms.vercel.app/docs/themes/halo) | A news front page whose sections editors curate |
| [`@tansy/theme-dispatch`](https://tansycms.vercel.app/docs/themes/dispatch) | A newsletter's site: the sign-up form up front and posts as numbered issues |
| [`@tansy/theme-storefront`](https://tansycms.vercel.app/docs/themes/storefront) | A shop: product cards, a product page with a size picker, and a cart |
| [`@tansy/theme-academy`](https://tansycms.vercel.app/docs/themes/academy) | A school's site for the LMS: the course catalogue, course pages and plans |

## Starting a new project

```sh
npm create tansy@latest
```

It asks what you're making, which theme, where it will run, SQLite or Postgres (or Postgres in Docker), where uploads go and which features to add, then installs, migrates and can create your admin account. Every question has a flag, and `--yes` takes the defaults: see [Start a new project](https://tansycms.vercel.app/docs/getting-started/new-project).

## Adding it to a Next.js app

```bash
npx create-next-app@latest my-site
cd my-site
npm install tansy
npx tansy init              # writes the entry files and a .env with new secrets
npx tansy migrate
npm run dev
```

`tansy init` never overwrites a file. Your root layout and home page move to `app/(site)/`, because the admin has its own root layout, and anything it can't change safely is printed as a step to do by hand. `npx tansy doctor` checks the result. The admin is at `/dashboard` and the API at `/api`, and your own routes, such as `/api/hello`, keep working beside them. Choose other paths with `tansy init --admin /admin --api /cms-api`.

`npx tansy init --site` adds a page that renders a theme, and the theme comes from `tansy.config.ts`:

```ts
import { blog } from "@tansy/theme-blog";

export default defineCms({ theme: blog({ tagline: "Field notes" }) });
```

## Quick start with Docker

No configuration is needed. Data, uploads and generated secrets live in the `/data` volume.

```bash
docker build -t tansy .
docker run --name tansy -p 8090:8090 -v tansy-data:/data tansy
```

The server log prints a one-time setup link. Open it to create the superadmin, then sign in at <http://localhost:8090>. If you publish a different port or a real domain, set `BETTER_AUTH_URL` to that address with `-e`.

For production with Postgres, set `POSTGRES_PASSWORD` and `BETTER_AUTH_URL`, then run `docker compose up -d`. The setup link is in `docker compose logs tansy`. Before going live, set up [backups](https://tansycms.vercel.app/docs/guides/backups) and copy `TANSY_BACKUP_KEY` from `/data/secrets.env` somewhere safe. Point your load balancer's health check at `/api/ready`, and see [running it](https://tansycms.vercel.app/docs/guides/operations) for what to watch.

## Running from source

Requires Node 24. SQLite is the default database, and any Postgres works through `DATABASE_URL`.

```bash
npm install
npm run tansy -- init       # writes .env with new secrets
npm run tansy -- migrate
npm run dev
```

On first start the server log prints a one-time setup link. Open it to create the superadmin.

`tansy init` is complete on its own: a SQLite file beside the app and uploads on local disk, like
Django's defaults. Before a real deployment, read [going to production](https://tansycms.vercel.app/docs/guides/production) —
above all, choose the database before you have content, because records don't move between SQLite
and Postgres.

## Checks

```bash
npm run check             # type-check, lint, unit and contract tests
npm run docs:build        # the documentation site in apps/docs
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:integration   # wipes that file
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:package       # the same suite, against the tarball in a fresh app
```

## Contributing

See [CONTRIBUTING.md](https://github.com/mhmdsalahsebai/tansy/blob/main/CONTRIBUTING.md) for the repository's layout, its commands, and the three rules
a change has to keep: the [security model](https://github.com/mhmdsalahsebai/tansy/blob/main/docs/contributing/security-model.md), the
[dashboard design system](https://github.com/mhmdsalahsebai/tansy/blob/main/docs/contributing/design-system.md) and translatable text.

## Releases

Every package in this repository moves on its own version, so a release publishes only what changed.
`node scripts/set-version.mjs <package> <version>` moves one package, and pushing a
`<package>@<version>` tag, such as `@tansy/blog@0.1.2`, runs the release workflow, which checks,
builds, publishes that package to npm with provenance and opens a GitHub release from its changelog:
a plugin's or theme's `CHANGELOG.md` in its folder, or [CHANGELOG.md](https://github.com/mhmdsalahsebai/tansy/blob/main/CHANGELOG.md) for `tansy` and create-tansy. What a release may change before 1.0, and what it may not
after, is [the deprecation policy](https://github.com/mhmdsalahsebai/tansy/blob/main/docs/contributing/deprecation.md), written for users as the
[upgrading guide](https://tansycms.vercel.app/docs/guides/upgrading).

## Licence

MIT. See [LICENSE](https://github.com/mhmdsalahsebai/tansy/blob/main/LICENSE). The same licence covers every plugin and theme in this repository.
