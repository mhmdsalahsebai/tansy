---
title: "Upgrading and versions"
description: "What a version number promises, what an upgrade asks of you, and what will never happen to your content. tansy and every @tansy/ plugin and theme are released together from one repository, so they share a version…"
---

What a version number promises, what an upgrade asks of you, and what will never happen to your
content. `tansy` and every `@tansy/*` plugin and theme are released together from one
repository, so they share a version number and an upgrade is one step for all of them.

## Beta: none of this holds yet

Tansy is beta software. **Before 1.0, any release can change anything** — a package name, a command,
a configuration key, an environment variable, a database column, a React component's props — in a
patch release, with no deprecation period and no migration path. Everything below this section
describes what holds from 1.0 onwards; the policy is written down now so you can see what you would
be relying on.

Until then:

- Pin exact versions, for `tansy` and for every `@tansy/*` package. Do not use `^` or `latest`.
- Read the [changelog](https://github.com/mhmdsalahsebai/tansy/blob/main/CHANGELOG.md) before every
  upgrade. Breaking changes are listed there and nowhere else.
- Take a [backup](/docs/guides/backups) before every upgrade, not only across a major version.
- Expect to touch your own code. Plugins and themes you have written against the extension API are
  the most likely thing to break.

## Upgrading

```bash
npm install tansy@latest
npx tansy migrate        # core's own database changes
npx tansy sync           # rewrites the import maps, after a plugin is added or removed
npx tansy doctor         # checks the result
```

Then start the app. A plugin's own schema changes — its collections and fields — run once on the
first boot after the upgrade, recorded per plugin, so there is no separate command for them.

Take a backup first. `tansy backup` writes one archive of the database and the uploads, and it is the
only thing that makes a bad upgrade cheap:

```bash
npx tansy backup
```

Across a **major** version, treat that backup as required rather than advisable. Database migrations
run forward only; there is no down-migration, and the way back is the archive.

Upgrade plugins and themes in the same step as core. They are versioned with it, and each one
declares the core range it accepts.

### What stops an upgrade, and why that is good

- A plugin built for an **older plugin API** stops startup with a message naming it. The API version
  changes only when an existing plugin would otherwise stop working.
- A plugin whose `requires: { cms: "^1.0.0" }` does not match the installed core stops startup and
  says which to change. Failing at startup is deliberate: the alternative is a plugin that half
  works once the site is live.
- A plugin **older than the version your database was last upgraded to** is refused, because its
  migrations have already run. Install the newer one.
- `tansy restore` refuses a backup made by a **newer** version whose database changes this one does not
  have, and names them. An older backup is brought up to date on restore.

## What a release may do

| Change | Release |
|---|---|
| Fix a bug, or anything private | Patch |
| Add an export, an optional property or a command | Minor |
| Deprecate something | Minor |
| Remove or rename something, or change what it accepts or returns | Major |
| Raise the minimum Node or Next.js major version | Major |

**Security fixes are the one exception.** If leaving something in place would keep sites exposed, it
can change in a minor or a patch release, and the release notes say so plainly and say what to do.

## What counts as public

The public API is:

- what the `tansy` package's `exports` list,
- the `tansy` commands,
- the plugin and theme manifests — what `definePlugin` and `defineTheme` accept.

Anything else is private and may change in any release, **including files you can reach by a deep
import**. Every export and its signature is recorded in a snapshot in the repository, so a pull
request that changes the API changes that file and the change is visible in review.

Your own content is not an API question at all: collections, fields, blocks, rules and URL patterns
are runtime data, so they are never affected by an upgrade except where this page says otherwise.

## How something is removed

1. **Warned about for at least one minor release.** It is marked deprecated in its own type, naming
   the replacement. Where it runs at startup or at build time, it also logs one warning that names
   the replacement.
2. **Removed in the next major release**, and not before.
3. **With a codemod where one is practical** — a rename, or a mechanical change of arguments. Where
   a change cannot be automated, the release notes say what to do by hand.

So a site that upgrades through minor releases and reads the warnings has a release's notice before
anything it uses disappears.

## Your content survives

This is the part that matters most, and it holds across a major version too:

- **A release never leaves stored records, blocks or plugin data unreadable.** A block type whose
  shape changed is upgraded on read by the steps its author declared, so old blocks keep rendering.
- **Removing a plugin or a theme keeps its data.** The collections it made and the records in them
  stay where they are; put the plugin back and they are live again. Nothing is deleted because a
  line left `tansy.config.ts`.
- **Deleting is always deliberate.** Hiding a language keeps its translations. Deleting a record
  sends it to the trash. Anything that really destroys content asks first and writes an audit entry.
- Database migrations run forward only, which is why a backup before a major upgrade is the
  instruction and not a suggestion.

## Plugin and theme contracts

`apiVersion` on a plugin or a theme changes only when an existing one would stop working — not for
additions. A plugin declaring the core range it accepts gets a clear message at startup if the
installed core is outside it, rather than an error somewhere later.

A theme version adds collections, blocks and missing fields when it goes up. It never changes an
existing field's type or settings, and a field added to a collection that already holds records
cannot be required.

## Where to look before upgrading

- The **changelog** in the repository is the one place each release is described, including anything
  to do by hand, and the limits that still stand.
- `tansy doctor` after an upgrade prints what is installed, with each plugin's version, routes and
  permissions.
- **Dashboard → Extensions** shows the same list in the dashboard.

Contributors changing the public API should read `docs/contributing/deprecation.md` in the
repository, which explains how the snapshot is kept and what a pull request has to do.
