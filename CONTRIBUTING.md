# Contributing

Thanks for looking at tansy. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md), and security problems are reported privately as [SECURITY.md](SECURITY.md) explains, never in an issue. This page is the short version of how the repository works and
which rules a change has to keep. The two reference documents it links to are binding: a change
that breaks them will fail `npm run check`.

## The repository

An npm workspace. Run every command from the repository root.

| Folder | What it holds |
| --- | --- |
| `packages/cms` | The CMS itself: `core/`, `components/`, `lib/`, `styles/`, `prisma/`, `app/api`, `app/dashboard`, `app/auth`, `app/account`, `routes/`, `sdk/`, `scripts/` |
| `packages/create-tansy` | The scaffolder behind `npm create tansy` |
| `apps/starter` | The host app: the entry files that call into the package, `proxy.ts` and the `cms.*` config files |
| `apps/docs` | The documentation site (Fumadocs). Its reference pages are generated from `docs/`, so write user documentation in `docs/`, never in `apps/docs/content` |
| `plugins/*`, `themes/*` | The first-party plugins and themes, each a published package |
| `examples/*` | Small, unpublished packages that show one extension point each |
| `docs/` | User-facing documentation, and `docs/contributing/` for the rules below |
| `tests/` | `unit/`, `contract/`, `integration/`, `e2e/`, `package/` |
| `internal/` | The maintainer's design notes and roadmaps. Not in the repository, so a comment that cites `internal/<SOMETHING>_PLAN.md` is a note to the maintainer, not a file you are missing |

## Commands

```bash
npm install
npm run dev                 # the starter app
npm run check               # types, lint, unit and contract tests. Must pass before a change is done
npm run docs:build          # the documentation site, which check doesn't cover
```

```bash
TEST_DATABASE_URL=file:./.data/cms_test.db npm run test:integration
```

The integration suite wipes the database it is given, so the name has to contain `test` or `smoke`.
Run it on both SQLite and Postgres when a change touches SQL. `npm run test:package` packs the
tarballs, installs them into a fresh `create-next-app` and runs the same suite there; run it when a
change touches `exports`, `scripts/`, the host entry files, or anything that only breaks once
compiled. `npm run db:migrate -- <name>` changes the Prisma schema and needs `POSTGRES_SCRATCH_URL`,
because every change gets a migration for both databases.

## The three rules

**1. The security model.** Read [docs/contributing/security-model.md](docs/contributing/security-model.md)
before adding an API route, a dashboard page, or anything that reads or writes records, users or
settings. In short: routes are exported as `route({...}, handler)` from `core/authz/guard.ts` with
an explicit access policy; authorization uses permissions from `core/authz/permissions.ts`, never
role names; Prisma and better-auth server APIs are used only in `core/`; dashboard pages call
`requirePage(...)`; the CMS's own addresses come from `lib/paths.ts`; writes declare an `audit`
action, and audit metadata never holds secrets.

**2. The design system.** Read [docs/contributing/design-system.md](docs/contributing/design-system.md)
before building or changing a dashboard page or a plugin's admin UI. Compose pages from
`components/ui/kit.tsx` (`tansy/admin` for plugins) instead of writing its `cms-*` classes by
hand, and use colour tokens, never literal colours.

**3. Every word is translatable.** Text a person reads belongs in the admin catalogs
(`core/i18n/catalogs`), in a plugin's `messages`, or for site pages in its render messages or the
theme's, and is shown with `t()`. The lint rule `i18n/no-literal-text` enforces it.

`eslint.config.mjs`, `tests/contract/` and `tests/unit/design-system.test.ts` are where these rules
are enforced. Don't relax them to make a change pass. A change to
`tests/contract/access-manifest.json` is a security change and a change to
`tests/contract/public-api.json` is a public API change: say so in the pull request, and for the
second one follow [docs/contributing/deprecation.md](docs/contributing/deprecation.md).

## Adding things

- **A route or a page:** run `npm run routes:generate -w tansy` afterwards.
- **A published package:** `node scripts/package-metadata.mjs` writes its `files`, its README and its
  peer ranges, and `tests/unit/package-metadata.test.ts` fails until they are right.
- **A release:** `node scripts/set-version.mjs <version>` moves every package at once, then the
  `release` workflow builds and publishes the tarballs from a `v<version>` tag.

## Pull requests

Keep the change and its tests together, say what you ran, and name anything you deliberately left
out. If `npm run check` can't pass for a reason outside your change, say so rather than working
around the rule it reports.
