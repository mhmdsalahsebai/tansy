# Tansy

Self-hosted, runtime-schema CMS on Next.js. Roadmap: `internal/NEXT_GEN_CMS_PLAN.md`.

An npm workspace. `packages/cms` holds `core/`, `components/`, `lib/`, `styles/`, `prisma/`, plus `app/api` and `app/dashboard`. `app/auth`, `app/account` and `routes/`. `apps/starter` holds only the entry files that call into it, `proxy.ts` and the `cms.*` config files. `apps/docs` is the public documentation site (Fumadocs, a workspace of its own with its own TypeScript version): its reference pages are generated from `docs/` by `npm run docs:sync`, so user-facing documentation is written in `docs/`, never in `apps/docs/content`. The contributor rules are tracked, in `docs/contributing/`; `internal/` holds only the maintainer's plans and is gitignored, so a comment citing `internal/<X>_PLAN.md` names a file a clone doesn't have. Paths below are relative to those. After adding or removing a route or page, run `npm run routes:generate -w tansy`. Run commands from the repo root.

## Security model is mandatory

Read `docs/contributing/security-model.md` before adding an API route, a dashboard page, or anything that reads or writes records, users or settings. In short:

- API routes are exported as `route({...}, handler)` from `core/authz/guard.ts`, with an explicit access policy.
- Authorize with permissions from `core/authz/permissions.ts`, never role names.
- Prisma and better-auth server APIs are used only in `core/`. Get better-auth through `getRuntime()`.
- Write the CMS's own addresses with `lib/paths.ts`, never as literals.
- `app/dashboard/**/page.tsx` are server components that call `requirePage(...)`.
- Any new way of serving records (realtime, expand, files, batch) must go through `authorizeRecord` or `decideRecord`.
- Writes declare an `audit` action. Audit metadata never contains secrets.
- Never relax `eslint.config.mjs` or `tests/contract` to make a change pass. Changes to `tests/contract/access-manifest.json` are security changes: call them out. Changes to `tests/contract/public-api.json` are public API changes: follow `docs/contributing/deprecation.md` and call them out.

## Dashboard design pattern is mandatory

Read `docs/contributing/design-system.md` before building or changing a dashboard page or a plugin's admin UI. Compose pages from `components/ui/kit.tsx` (`tansy/admin` for plugins): `PageHeader`, `Card`, `Toolbar`, `Badge`, `Button`/`ButtonLink`, `Tabs`/`TabLinks`, `Timeline`. Don't write their `cms-*` classes by hand; extend the kit instead. Colours in component CSS are tokens only. Never relax `ui/use-kit` or `tests/unit/design-system.test.ts` to make a change pass.

## Commands

- `npm run check`: type-check, lint, unit and contract tests. Must pass before a change is done. It doesn't cover `apps/docs`, which has its own `npm run docs:build`.
- `npm run test:integration`: end-to-end security suite. Needs `TEST_DATABASE_URL` set to a disposable SQLite file or Postgres database whose name contains `test` or `smoke`, such as `file:./.data/cms_test.db`; it wipes it. Run it on both databases when a change touches SQL.
- `npm run test:package`: packs the tarball, installs it into a fresh `create-next-app`, and runs the integration suite there. Takes the same `TEST_DATABASE_URL`. Run it when a change touches `exports`, `scripts/`, the host entry files or anything that only breaks once compiled. `-- --only init|suite|scaffold` (comma-separated) runs part of it, as CI does side by side.
- `npm run db:migrate -- <name>`: changes the Prisma schema. Needs `POSTGRES_SCRATCH_URL`, because each change gets a migration for both databases.
- `npm run package`: builds the tarball npm receives for every published package, into `.release/`. Plugins and themes are compiled, so their `exports` point at `.js` and `.d.ts` in what ships, never at source.
- `npm run package:metadata`: writes each published package's `files`, README and peer ranges. Run it after adding a plugin or theme, or `tests/unit/package-metadata.test.ts` fails.
- A release: `node scripts/set-version.mjs <version>` moves all 62 packages at once, then a `v<version>` tag runs `.github/workflows/release.yml`.
