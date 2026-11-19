# Limits and boundaries

Every feature here has an edge, and this page is the list of them in one place, so you meet them
while you are choosing rather than halfway through building. Some are decisions that will not
change, some are work not done yet, and each one below says which.

Nothing here is a bug. Where a limit has a workaround, the workaround is named. The guide for each
area repeats the limits that belong to it, with more detail.

## One server

**Decided.** The CMS expects **one server process**. Realtime connections, scheduled publishing,
jobs, cron, and the webhook and search queues all run inside it, on either database. Two instances
behind a load balancer would each run the queues and each hold their own caches.

- Scheduled publishing runs on a 30-second tick, so a time can be up to 30 seconds late. A server
  that was stopped catches up when it returns, but a missed **job** run is not made up.
- The site read cache lives in the process and holds an entry for at most 30 seconds
  (`TANSY_SITE_CACHE_SECONDS`, `0` turns it off). That is how long a rule comparing a field with
  `@now` can lag.

Scaling up means a bigger machine, not more machines. See [Going to production](production.md).

## Pages and caching

**Decided, and not pending.** Pages render on **every request, and a CDN cannot cache the HTML**.
Each page carries a per-request CSP nonce, and the nonce is what makes the script policy strict: a
stored copy served to somebody else carries a nonce their policy does not match, so every script on
the page is blocked. The response says `Cache-Control: private, no-cache` so a CDN's heuristics
cannot quietly break a site, and everything that *is* cacheable — `/_next/static`, uploads,
thumbnails — carries its own policy already.

- A record write drops only the cached reads that touched that collection — its own, the ones
  `expand` crossed, the ones a rule read through `@collection`, and the one a relation filter
  followed. A **schema, settings, language, redirect or file** change drops everything, because any
  of them can change any read.
- A headless site's cached reads are cleared by a webhook, and webhooks carry record changes only,
  so a schema or settings change there waits for its `revalidate` time.
- A preview shows that record's own draft. Records it links to, and every other page, are as a
  visitor sees them.
- Every `paged` query on one page follows the same `?page=` number.

## Access rules and filters

- **A saved rule cannot follow a relation**, as in `author.name = "x"`. A rule is compiled to SQL or
  evaluated per row, and neither can read another collection. Use `@collection`. A **caller's
  filter** can follow one relation, forwards or backwards, and so can a theme's query, because they
  are resolved before the query runs. A realtime filter cannot, being checked per event.
- `@collection` compares against **every** value of a field and cannot be joined to the current
  record, so `@collection.x.owner = id` means "every value equals". Use `?=` for "some row matches".
  A rule that would read more than 10,000 records denies access rather than judging from part of the
  table.
- Each expanded relation serves at most 1,000 records per level. Expansion goes 4 levels deep,
  across at most 8 paths, and `?expand=<stream field>` goes one level: records linked from blocks do
  not expand further.
- A condition SQL cannot express — `~`, JSON paths, comparing two columns — is evaluated in the
  server on the rows SQL narrowed, and a request that would check more than 100,000 rows refuses
  with `FILTER_TOO_BROAD`.
- Filters on SQLite run the evaluator per row, so they do not use indexes.
- **View collections** always run their rules in the server, because a computed column has a type
  only the database knows. A view cannot read a scoped table at all.

## Content, blocks and history

- Each record keeps its latest **100 revisions**. The limit is not configurable yet.
- Restoring or publishing fails with a field error if a file or a linked record has been deleted
  since. Links in a draft are checked when it is published, not when it is saved.
- A restored block whose type is gone or out of date is kept exactly as stored, but its links and
  files are not indexed until the block is updated, so those files stay private.
- An old or deleted block nested inside a block being updated to the current version has to be
  removed or updated in the same save.
- Changing a block type does not reindex the records that use it. They catch up when next saved.
- Deleting a collection removes the index rows for links to it; the ids stay inside stored blocks.
- The history page compares a revision with the one before it. The API can also compare with the
  live record or any other revision.
- An import is at most 2,000 rows and 12 MB per request, each row its own transaction, with no undo.
  See [Working with content](content.md).

## The media library

**Not built yet**, all of it:

- no folders and no tags,
- no crop saved per use,
- no direct-to-bucket upload, and no multipart upload for very large files. Uploads go through the
  server, so the size limit (50 MiB by default) also bounds temporary disk use.

Also worth knowing:

- A focal point is **not per language and not versioned**, and neither is a file's alternative text:
  changing either changes every page that uses the file.
- Core's own thumbnails, which includes local disk and S3, honour the focal point. A storage plugin
  with its own image service (Cloudinary, Bunny) crops from the middle: core passes the focal point,
  and those adapters do not use it yet.
- Replacing a file's bytes leaves already-cached pages with the old width, height and type until
  their reads expire.

See [Files and storage](storage.md).

## Users and sign-in

- Sign-up forms do not collect custom user fields, so `required` on one only stops a value being
  cleared. Give anything your rules need from the start a default.
- A user field cannot hold blocks, files or record links, cannot be unique, and cannot change type.
- There is **one auth collection**: one pool of people, with roles. Several auth collections remain
  later work.

## The API

- `POST /api/batch` cannot upsert and cannot upload files, and takes JSON only.
- The MCP server offers **tools only**, over plain JSON responses with no streaming.
- Schema import is **not one transaction**, and it never deletes a collection. Links between
  collections are converted only through a field's `collection` config.
- A hook file cannot use `@/` imports, and a helper file's changes apply when the entry file is
  saved.

## Operations

- `/api/metrics` has no request counters and no latency histograms: those belong to whatever sits in
  front of the server, and per-request detail is the request-logs plugin's. The search queue's depth
  is not a metric yet either.
- **`/api/ready` does not check the search engine, the mail transport or a plugin's own service**, so
  a server whose search engine is down still reports ready — and serves reads from the built-in
  index.
- See [Running it](operations.md).

### Backups

- **A backup restores onto the same kind of database.** There is no SQLite → Postgres path for
  records: that would need a portable dump rebuilding record tables, views and search indexes, which
  is its own project. Choose the database before you have content ([production](production.md)).
- Postgres needs the client tools of at least the server's major version, and a restore needs a role
  that may drop and recreate `public`. SQLite needs nothing.
- Restores go back to the last archive. Continuous archiving — Litestream, a provider's
  point-in-time recovery — is left to the database.
- Files are copied through the server four at a time, with no incremental or deduplicated archives.
- There is no dashboard page for backups yet. A run's status is in the audit log and in the
  `cms.backup` job run.

See [Backups](backups.md).

### On Postgres

- `StoredFile.size` is a 32-bit integer, so a single file cannot exceed 2 GiB.
- JSON columns are `JSONB`, which does not keep an object's key order.

## Languages

A one-language site pays nothing for localization, and the boundaries only matter once you add a
second language: one record holds every translation of itself rather than a record per language,
settings other than site text are not localized, prices per market are a shop's concern rather than
a language feature, and nothing is translated automatically on save. The dashboard's own words are
catalogs in code, so an owner can change the **site's** wording, not the admin's. See
[Many languages](localization.md).

## Many tenants

With `@tansy/multi-tenant`, a tenant has its own records, files, domains, settings, members,
limits and theme. **A theme's options are not per tenant**: a tenant picks which installed theme
serves its site, but a theme's `options` are set in `tansy.config.ts`, so they are the instance's, and
the block editor's canvas shows blocks in the default theme. A tenant with no verified domain has no
feed of its own, because feed routes and the API are served at the root. There is no database or
schema per tenant, no collections or fields for one tenant only, and no billing. See
[the multi-tenancy plugin](../plugins/multi-tenant.md).
