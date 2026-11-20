<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/docs/public/brand/logo-light.png">
    <img src="apps/docs/public/brand/logo-dark.png" alt="Tansy" height="64">
  </picture>
</h1>

A self-hosted content backend on Next.js with runtime-defined collections, and authentication and authorization managed from its dashboard.

> **Beta.** Tansy is pre-1.0 and under active development. Any release can change anything — package
> names, commands, configuration keys, environment variables, database columns — in a patch release
> and without a deprecation period. Pin exact versions, read the [changelog](CHANGELOG.md) before
> every upgrade, and take a [backup](docs/guides/backups.md) first. The compatibility promises in
> [upgrading](docs/guides/upgrading.md) start at 1.0.

Full documentation, including the guides, every plugin and every theme, is at **<https://tansycms.vercel.app>**, built from `docs/` in this repo (`apps/docs`).

## Try the demo

A live install with the blog, shop and courses plugins and some sample content:
**<https://tansy-demo.vercel.app/dashboard>**

| Email | Password |
| --- | --- |
| `demo@example.com` | `explore-tansy-demo` |

The demo account is shared by everyone and can only look: browse the collections, records, block
editor, files, roles and settings. It can't change anything, including its own password. To try
editing, run your own copy with `npm create tansy@latest`, which takes a minute.

## Quick start with Docker

No configuration is needed. Data, uploads and generated secrets live in the `/data` volume.

```bash
docker build -t tansy .
docker run --name tansy -p 8090:8090 -v tansy-data:/data tansy
```

The server log prints a one-time setup link. Open it to create the superadmin, then sign in at <http://localhost:8090>. If you publish a different port or a real domain, set `BETTER_AUTH_URL` to that address with `-e`.

For production with Postgres, set `POSTGRES_PASSWORD` and `BETTER_AUTH_URL`, then run `docker compose up -d`. The setup link is in `docker compose logs tansy`. Before going live, set up [backups](docs/guides/backups.md) and copy `TANSY_BACKUP_KEY` from `/data/secrets.env` somewhere safe. Point your load balancer's health check at `/api/ready`, and see [running it](docs/guides/operations.md) for what to watch.

## Starting a new project

```sh
npm create tansy@latest
```

It asks what you're making, which theme, where it will run, SQLite or Postgres (or Postgres in Docker), where uploads go and which features to add, then installs, migrates and can create your admin account. Every question has a flag, and `--yes` takes the defaults: see [Start a new project](apps/docs/content/docs/getting-started/new-project.md).

To extend it, see the guides for [plugins](docs/guides/plugins.md), [custom fields](docs/guides/fields.md) and [themes](docs/guides/themes.md). Before you commit to it, the [limits](docs/guides/limits.md) are every boundary in one place, and [upgrading](docs/guides/upgrading.md) is what a version number promises.

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

## Building a site

`npx tansy init --site` adds a page that renders a theme, and the theme comes from `tansy.config.ts`:

```ts
import { blog } from "@tansy/theme-blog";

export default defineCms({ theme: blog({ tagline: "Field notes" }) });
```

`themes/blank` is a starting point, `themes/blog` a working example, and `themes/magazine` a fuller one: image cards, search and a sidebar ([docs](docs/themes/magazine.md)). `themes/halo` is a news front page whose sections editors curate from a Front page record ([docs](docs/themes/halo.md)). `themes/storefront` redesigns the shop plugin's pages, styled with Tailwind compiled inside the theme ([docs](docs/themes/storefront.md)). `themes/dispatch` is a newsletter's site: the sign-up form up front and posts as numbered issues ([docs](docs/themes/dispatch.md)). `themes/academy` is a school's site for the LMS: the course catalogue, course pages, and plans that open courses, worked out from the data ([docs](docs/themes/academy.md)). A headless site renders the same theme package over the API. See "Themes" in [docs/EXTENDING.md](docs/EXTENDING.md).

## Languages

Add languages on the dashboard's **Languages** page, each with a fallback, then turn on **Languages** in a collection's schema and mark the fields that differ per language as localized. A record keeps one id. Each language is published on its own, and visitors only ever see published translations. Translators can be limited to their own language with `locale:edit@<code>`, and the editor shows the source text, outdated fields, XLIFF export and import, and machine translation through any plugin that provides it.

The site gets an address per language (`/fr/...` or a domain per language), `hreflang` alternates, right-to-left pages, and the theme's words per language, which owners can change under **Languages → Site text**. The API and SDK take `?locale=`. Each person picks the dashboard's language under **Account**. English and Arabic ship with core and the first-party plugins. The whole of it is in the [languages guide](docs/guides/localization.md), and building for it in [docs/EXTENDING.md](docs/EXTENDING.md).

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
Django's defaults. Before a real deployment, read [going to production](docs/guides/production.md) —
above all, choose the database before you have content, because records don't move between SQLite
and Postgres.

## Backups

`tansy backup` writes one encrypted archive of the database and uploads, on a schedule or by hand, to any storage adapter, and `tansy restore` puts it back. Both databases are covered, each copied by its own tools. See [docs/guides/backups.md](docs/guides/backups.md).

## Search

`/records?search=` runs in the database by default. Set `search` in `tansy.config.ts` to Meilisearch, Typesense or Algolia to use an outside engine instead, kept in step through a queue that retries until the engine has every change. See [docs/guides/search.md](docs/guides/search.md).

## Analytics

`@tansy/analytics` counts page views with no cookies and nothing personal kept, and shows them on the dashboard. Add `@tansy/analytics-plausible`, `-umami`, `-google`, `-fathom` or `-matomo` to send them to that service as well, and to see its numbers on the dashboard. See [docs/plugins/analytics.md](docs/plugins/analytics.md).

## Checks

```bash
npm run check             # type-check, lint, unit and contract tests
npm run docs:build        # the documentation site in apps/docs
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:integration   # wipes that file
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:package       # the same suite, against the tarball in a fresh app
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository's layout, its commands, and the three rules
a change has to keep: the [security model](docs/contributing/security-model.md), the
[dashboard design system](docs/contributing/design-system.md) and translatable text.

## Releases

Every package in this repository moves on one version. `node scripts/set-version.mjs <version>` sets
it everywhere, `npm run package` builds a tarball per package, and pushing a `v<version>` tag runs
the release workflow, which checks, builds, publishes to npm with provenance and opens a GitHub
release from [CHANGELOG.md](CHANGELOG.md). What a release may change before 1.0, and what it may not
after, is [the deprecation policy](docs/contributing/deprecation.md), written for users as the
[upgrading guide](docs/guides/upgrading.md).

## Licence

MIT. See [LICENSE](LICENSE). The same licence covers every plugin and theme in this repository.
