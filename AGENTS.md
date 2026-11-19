# Tansy

The rules for working in this repository are in [CLAUDE.md](CLAUDE.md), the short version for people
in [CONTRIBUTING.md](CONTRIBUTING.md). Read, before writing any code that touches them:

- [docs/contributing/security-model.md](docs/contributing/security-model.md) — for an API route, a
  dashboard page, or anything that reads or writes records, users or settings.
- [docs/contributing/design-system.md](docs/contributing/design-system.md) — for a dashboard page or
  a plugin's admin UI.

`npm run check` has to pass before a change is done. `internal/` holds the maintainer's plans and is
not in the repository, so a comment citing `internal/<SOMETHING>_PLAN.md` names a file you don't have.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
