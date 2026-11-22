# Changelog

What changed in each release of `tansy` and create-tansy. Up to 0.1.0, every `@tansy/*` plugin and
theme was released with them on the same version, and their changes are below too. From 0.1.1 each
moves on its own version and keeps its own `CHANGELOG.md` in its folder, such as
[plugins/blog/CHANGELOG.md](plugins/blog/CHANGELOG.md) or
[themes/storefront/CHANGELOG.md](themes/storefront/CHANGELOG.md).

**Tansy is beta software. Before 1.0, any release can change anything**, including renaming or
removing a package, a command, a configuration key, an environment variable or a database column,
and it can do so in a patch release and without a deprecation period. Read this file before every
upgrade, pin exact versions, and take a backup first. From 1.0 the public API is what the `tansy`
package's `exports` list, plus the `tansy` commands and the plugin and theme manifests: adding to it
is a minor release, removing or renaming anything is a major one, and nothing is removed without at
least one minor release deprecating it first.

Security fixes are called out as such, with what to do about them, and can land in a minor or patch
release when leaving something in place would keep sites exposed.

## 0.1.3 — 2026-11-22

### Demo mode

- `TANSY_DEMO_EMAIL` and `TANSY_DEMO_PASSWORD` make an instance a public demo. Visitors who aren't
  signed in see a banner above every site page, in the page's language and with any theme, saying
  this is a demo, with a button to the dashboard. The sign-in form starts filled in with the demo's
  login and says so, so trying the dashboard takes one press. The demo address is always treated as
  a shared account. See "A public demo" in the production guide.

## 0.1.2 — 2026-11-22

### Storage

- `storageIndex(name)` from `tansy/storage` keeps a small JSON value per key in the database, for a
  storage adapter whose provider picks its own address for each upload and can't be asked for it
  again. `@tansy/storage-imgbb`, released beside it, keeps its images' addresses there.

## 0.1.1 — 2026-11-22

From this release every package moves on its own version. The storefront and halo themes' changes
released beside it are in their own changelogs.

### Files

- A fourth thumbnail size, `1600x0`, keeps an image's shape within 1600 pixels wide, for covers
  shown across a wide screen. `fileUrl(id, "1600x0")` takes it in a theme's `TemplateProps` and the
  site reader.
- Purging a scope now deletes every thumbnail size of its files, read from the same list the
  thumbnails are made from.

### Dependencies

- Minor and patch updates across the workspace.

### create-tansy

- No changes of its own; released beside `tansy` 0.1.1.

## 0.1.0 — 2026-11-20

The first public release. Everything below is new, so this entry describes what the package does
rather than what changed.

### Content

- Collections, fields and access rules defined at runtime from the dashboard. No migration, no
  redeploy, no code generation.
- 16 field types, custom field types through `defineField`, generated config forms and custom React
  inputs.
- A block field (`stream`) with runtime block types, nesting, drag reordering, previews, version
  stamping and upgrade steps that run on read.
- Rich text on TipTap, stored as JSON, with an allowlist enforced on the server.
- A revision per saved change with restore and diffs, pending drafts on published records, scheduled
  publish and unpublish, an optional review workflow, and a trash with retention.
- CSV and JSON import with a dry run, per-row errors and matching on a unique field.
- Files on local disk or any S3-compatible service, with thumbnails, focal points, alternative text
  per language, byte replacement under the same id, and a library.

### Access

- `TANSY_SHARED_ACCOUNTS` names accounts whose login is handed out, as for a public demo: anyone
  can sign in and use the account's role, nobody can change the account, sign others out of it or
  lock it with failed sign-ins.
- Roles carry permissions; per-collection rules decide which rows a caller may read or write. The
  same rules apply to the API, the dashboard, realtime, files and the site's own pages.
- A rule language with a parser, an evaluator, save-time validation and SQL compilation, including
  `@collection` lookups.
- A caller's filter may follow one relation, forward or backwards, resolved against the target's own
  view rule so a filter can never probe a record the caller may not read.
- Authentication on better-auth: passwords, passkeys, API keys, OAuth providers through
  `@tansy/social-sign-in`, custom user fields, and a breach check through
  `@tansy/pwned-passwords`.

### API and clients

- `GET /api/collections/:slug/records` with `page`, `perPage`, `sort`, `filter`, `expand`, `fields`
  and `skipTotal`, plus flat writes on `/records`, `POST /api/batch` in one transaction, and
  realtime over SSE with rule checks per event and client.
- Generated types, an OpenAPI 3.1 document, the TypeScript SDK in `tansy/sdk`, and an MCP server
  at `/api/mcp`.
- Signed, retried webhooks, each delivery limited to what the webhook's owner can read.
- Save conflicts: `expectedUpdatedAt` or `If-Match`, answered with `409 RECORD_CHANGED`.

### Languages

- A language per record with fallbacks, prefix or domain routing, `hreflang`, right-to-left pages,
  XLIFF 2.0 export and import, machine translation through any plugin that provides it, and a
  Translator role.
- The dashboard itself is translated, with the interface language per person. English and Arabic
  ship for core and for the first-party plugins and themes.

### Sites and themes

- `tansy/server` for rule-checked reads as a visitor, `defineTheme`, `<ThemedPage>` rendering the
  same theme in the same app or over the API, signed previews, and cached reads dropped per
  collection on a write.
- Themes: `blank`, `blog`, `magazine`, `halo` (a news front page whose sections editors curate), `storefront`, `dispatch` and `academy`.
- Several themes in one build, with `themes` in `tansy.config.ts`, the first being the default. With a
  scope provider, each scope value picks one under **Site**, so two tenants serve their own themes
  from one install. A theme's `options` stay the instance's.

### Plugins

- `definePlugin` for fields, blocks, permissions, hooks, routes, jobs, agent tools, settings and
  admin pages, with compatibility checks, namespaces, validated options, upgrade steps and a
  key-value store. `cms_hooks/` files need no build.
- First-party: blog, LMS, shop, payments, subscriptions, forms, newsletter, email, CAPTCHA, AI,
  analytics, request logs, OpenTelemetry logs, multi-tenancy, SEO, social sign-in and pwned passwords, plus one small
  adapter package per outside provider for AI, email, payments, CAPTCHA, analytics, file storage and
  search.

### Operations

- `/api/health`, `/api/ready` and `/api/metrics` in Prometheus text behind `setting:read`.
- Encrypted backups of the database and uploads to any storage adapter, with `tansy backup`,
  `tansy restore`, `list` and `verify`, on a schedule or by hand.
- Read rate limits per caller, request logs, audit entries on every write, and housekeeping for
  trash, uploads and queues.
- The audit log and request log over OpenTelemetry with `@tansy/logs-otlp`, besides the request
  log's storage, HTTP and console destinations. Repeated refusals from one caller are folded into
  one audit entry, so nobody outside can grow the log without bound.
- A Docker image and `docker-compose.yml` that need no configuration on first boot.
- Several servers can start at once against a new database, as serverless hosts do on their first
  requests: one runs the startup setup (blocks, field upgrades, plugin migrations, theme seeds)
  while the others wait, so none of them fails on what another just created. The first-run setup
  link stays valid for its hour however many servers start meanwhile.

### Installing it

- `npm create tansy@latest` for a new project, or `npm install tansy && npx tansy init` for an app you
  already have, with `tansy doctor` to check the result. In a terminal, `create-tansy` asks for the
  theme, the host, the database (SQLite, Postgres, or Postgres it starts in Docker), where uploads
  go, which features to add and whether to create the admin account, and every question has a flag
  for scripts and CI.
- SQLite or Postgres from one build.
- The `tansy` CLI: `init`, `sync`, `migrate`, `superadmin`, `types`, `routes`, `doctor`, `tick`,
  `backup`, `restore`, and scaffolding for plugins, fields and themes.

### Known limits

These are product boundaries rather than bugs. The documentation states each one where it applies,
and `docs/guides/limits.md` is the whole list in one place. The ones worth knowing before you start:

- **One server process** on either database: realtime, scheduled publishing, jobs, cron and the
  webhook and search queues all run in it. Scaling means a bigger machine, not more machines.
- **Pages render per request and a CDN cannot cache the HTML**, because each page carries its own
  CSP nonce. This is settled rather than pending. Static assets, uploads and thumbnails carry their
  own cache policy, and a cached site read is held for at most 30 seconds.
- **A saved rule cannot follow a relation**; use `@collection`. A caller's filter can follow one,
  and so can a theme's query. A realtime filter cannot.
- **A backup restores onto the same kind of database**, so there is no SQLite → Postgres path for
  records: the schema travels as code, the records do not. Pick the database before you have
  content. A Postgres restore needs the client tools of at least the server's major version.
- **The media library has no folders, no tags and no direct-to-bucket upload.** Uploads go through
  the server, capped at 50 MiB by default.
- **`/api/ready` does not check the search engine or the mail transport**, so a server whose search
  engine is down still reports ready, and serves reads from the built-in index.
- **A theme's options are not per tenant**: a tenant picks which of the installed themes serves its
  site, beside its own site name and colours, but a theme's `options` are set in `tansy.config.ts`.
  The block editor's canvas shows blocks in the default theme, there being one editor per instance.
  A tenant with no verified domain has no feed of its own, feed routes being served at the root.
