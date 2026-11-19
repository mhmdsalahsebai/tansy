# Deprecation policy

This applies from 1.0. Before 1.0, any release can change anything.

The same policy written for the people relying on it — what an upgrade asks of them, and what will
never happen to their content — is on the documentation site, in
[guides/upgrading.md](../guides/upgrading.md). It is a promise to users, so it is published rather
than kept here. Change both together.

## What's public

The public API is what `exports` lists in the `tansy` package, plus the `tansy` commands and the plugin and theme manifests. Anything else is private and can change in any release, including files you can reach by a deep import.

`tests/contract/public-api.json` records every export and its signature. A pull request that changes the API changes that file, so the change is visible in review. Update it with `npx vitest run tests/contract/public-api.test.ts -u`.

## What a release may do

| Change | Release |
|---|---|
| Fix a bug, or anything private | Patch |
| Add an export, an optional property or a command | Minor |
| Deprecate something | Minor |
| Remove or rename something, or change what it accepts or returns | Major |
| Raise the minimum Node or Next.js major version | Major |

## How something is removed

1. **Warn for at least one minor release.** Mark it `@deprecated` in its type, naming the replacement. Where it runs at startup or at build time, also log one warning that names the replacement.
2. **Remove it in the next major release**, and not before.
3. **Provide a codemod where practical**, meaning a rename or a mechanical change of arguments. If a change can't be automated, the release notes say what to do by hand.

Security fixes are the one exception. If keeping something would leave sites exposed, it can change in a minor or patch release, and the release notes say so plainly.

## Stored data

A release never leaves stored records, blocks or plugin data unreadable, including on a major version. Removing a plugin or theme keeps its data. Database migrations run forward only, so take a backup with `tansy backup` before a major upgrade. `tansy restore` refuses a backup made by a newer version, and brings an older one up to date.

## The plugin and theme contracts

`apiVersion` on a plugin or theme changes only when an existing one would stop working. A plugin declaring `requires: { cms: "^1.0.0" }` stops startup with a clear message on a version outside that range, rather than failing later.
