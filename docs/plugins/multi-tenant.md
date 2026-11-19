# Multi-tenancy plugin (`@tansy/multi-tenant`)

Many sites, or many customers, in one install. Each **tenant** has its own records in every
collection marked scoped, its own files, domains, settings, redirects, theme, members and limits,
and never sees another tenant's rows.

```ts
// tansy.config.ts
import { multiTenant } from "@tansy/multi-tenant";

plugins: [multiTenant({ siteUrl: "https://cms.example.com" })]
```

Three kinds of owner want this, and it serves all three: an agency running twenty client sites on
one server, a brand group with a site per branch and a shared catalogue, and a SaaS product where
each customer gets a CMS space of their own.

Without the plugin, nothing here is visible and nothing costs anything. One site stays one site.

## 1. The approach

Tenancy is **one plugin on a general core mechanism**. Core provides *row scopes*: a value a plugin
resolves per request, which core then enforces on every record, file, setting and service, below
roles and rules (see "Row scopes" in the security model and in
[Extending Tansy](../EXTENDING.md)). The plugin provides the policy: what a tenant is, who
belongs to one, how one is chosen, and the dashboard for all of it.

| Core | This plugin |
|---|---|
| The scope column, set on insert and added to every read and write | A tenant is a better-auth organization |
| Scope-bound roles, capped so they can never hold instance permissions | Memberships, with CMS role names |
| Per-collection scope mode, and per-scope uniqueness | How a request's tenant is decided |
| Scoped settings, sites, cache, files, store, jobs, webhooks, realtime, search, audit | Invitations, domains and their DNS verification |
| Export, import and purge of one scope value | Tenant pages, the switcher, limits, suspend and purge |

Isolation is one shared database with one schema. **The schema is instance-wide** — collections,
fields, blocks, plugins and the installed themes are the same for everyone — and the data is per
tenant. Which installed theme serves a tenant's site is that tenant's own choice. Owners
who need harder isolation than a shared database run one instance per tenant.

Tenants, members and invitations are better-auth's `organization` plugin, with every one of its HTTP
endpoints closed off: its tables are system-owned collections that only the plugin's own writes
touch, its role checks use the CMS's own roles, and every change goes through one of this plugin's
routes, with a permission, Zod validation and an audit entry.

## 2. Collections: scoped, shared or single

Every collection has a **scope mode**, on its Schema page and in the schema export:

| Mode | What it means |
|---|---|
| `scoped` | A set of records per tenant. The default for new collections while the plugin is installed |
| `shared` | One set of records everyone sees, edited with instance permissions. A catalogue, say |
| `single` | One record per tenant: a homepage, a set of site-wide values |

A mode cannot change while the collection holds records. `unique` fields and URL patterns are unique
**per tenant** on `scoped` and `single` collections, so two clients can both have a record at
`/about`. A `shared` record cannot link to a `scoped` one (`SHARED_TO_SCOPED`), so a shared page can
never show one tenant's record to another. A view collection cannot read a scoped table, because a
view's own SQL is not narrowed; scoping a collection a view reads is refused with
`VIEW_DEPENDENCY`.

## 3. Which tenant a request is in

The plugin tries these in order, and each is only a **hint**: core then asks for the caller's roles
in that tenant and refuses when they have none and no instance permission covers it.

1. a **verified domain** matching the request's host;
2. the tenant a **path prefix** names, read only on the instance's own address: `/acme/blog/hello`,
   where `acme` is the tenant's short name;
3. the **API key's** tenant;
4. the `x-cms-tenant` header, for signed-in callers only;
5. the session's **active tenant**, chosen with the switcher in the top bar.

A signed-out visitor gets a tenant from a domain or a path prefix and from nothing else. A key bound
to one tenant sent to another's domain, or with another's header, is `403 SCOPE_MISMATCH`. A member
with no choice that still applies works in the first tenant they joined; staff who can reach every
tenant work in none until they choose one.

Resolution runs inside `route()` and `requirePage`, so it is in one place for every API route and
every dashboard page.

**A verified domain always wins**, and the path prefix is read only beneath it. So a path can never
move a visitor off one tenant's own domain onto another's. A tenant keeps its prefix after it
verifies a domain, so links shared beforehand keep working, and the domain is canonical from then
on. The CMS's own first path segments — `/api`, `/dashboard`, `/_next` — are reserved, and
`POST /tenants` refuses a short name that would collide with one.

Addresses are matched and compared without the prefix and carry it on the way out: alternates,
redirects, previews, a tenant's emails and feeds, and hand-typed `menu_item` URLs, which are
rewritten when the site reads the record so stored values stay canonical and the same record serves
correct links both on the tenant's domain and under its prefix.

## 4. Permissions and roles

| Permission | For |
|---|---|
| `ext.multi-tenant:create` | Making a tenant |
| `ext.multi-tenant:read` | Reading a tenant's plan: its limits and what it is using against them |
| `ext.multi-tenant:update` | Renaming a tenant, setting its limits, the plugin's settings |
| `ext.multi-tenant:delete` | Suspending, resuming, exporting, and asking for a purge |
| `ext.multi-tenant:members` | Members and invitations, inside a tenant |
| `ext.multi-tenant:domains` | Domains, inside a tenant |
| `ext.multi-tenant:all` | Reaching every tenant. Each switch is audited |

Three roles are created by the plugin's own migration:

- **Tenant admin** (scoped): one tenant's records, redirects, site name and look, and its members.
- **Tenant editor** (scoped): writes one tenant's records.
- **Tenant staff** (instance): sees every tenant and works in any of them with their other roles.

A **scoped** role is declared as such when it is made and grants nothing at instance level. Core
caps what one may hold — `dashboard:access`, `collection:read`, `file:create`, `locale:edit`, record
permissions, and any of the plugin's own permissions it declares as scoped — and a grant for every
collection becomes a grant for each scoped collection. There is one role editor and one permission
catalogue: **Dashboard → Roles**, as for everything else.

## 5. The dashboard

A **Tenants** section, built from the kit like any other plugin's pages:

- **Tenants** — the list, creating one, renaming, limits, and the danger zone.
- **Members** — who is in this tenant and which roles they hold, and the invitations outstanding.
- **Domains** — the hosts claimed for this tenant, each with its DNS proof and whether it is the
  main one.
- **Settings** — how long an invitation lasts, the name of the TXT record that proves a domain, and
  how long a suspended tenant waits before a purge.

A **tenant switcher** sits in the top bar, from core's `switcher` slot. Dashboard pages resolve the
tenant exactly as API routes do, so a plugin's own page or widget reads inside it too.

## 6. Domains

A domain claims nothing until DNS proves it. Add the host, put the TXT record it shows under the
configured name, then verify. Only after that does the host route to the tenant and join the
trusted origins better-auth accepts sign-in from. A nightly job re-checks every verified domain, and
one whose proof has gone missing stops routing after a grace period rather than at once. The host
and short-name maps are held for 15 seconds per server and cleared immediately when a tenant is
made, suspended, resumed or purged.

The dashboard stays on the instance's own address. Members sign in on a tenant's own domain with
that domain's cookie.

### A tenant's own theme

A build can install several themes, with `themes` in `tansy.config.ts` instead of `theme`, and
**Dashboard → Site** then shows a **Theme** field beside the site's name, logo and colour. The
tenant's pages are served in the theme it picked; one that picks nothing, and the instance's own
pages, get the first theme in the list. Anyone with `setting:site` in that tenant can change it, and
the change needs no rebuild — only adding a theme to the list does. A theme that leaves the build
later serves the default rather than nothing. See
[Several themes in one build](../guides/themes.md#several-themes-in-one-build).

## 7. What is per tenant

Records, files (their storage keys are prefixed by the tenant), settings marked per-scope — site
name, branding, theme, redirects, public languages, mail sender — plugin stores, jobs, cron runs,
webhooks and their deliveries, realtime topics, search documents and audit entries. Auth, security, storage
and backup configuration stay instance-wide, because one user table means one authentication setup.

Other plugins need nothing special: their collections take a scope mode like any other, and the
blog, shop, newsletter, forms and analytics plugins all run per tenant. A plugin can be turned off
for one tenant.

## 8. Limits and lifecycle

Each tenant has a plan: a cap on **records**, **bytes of files**, **members** and **requests a
minute**, any of which may be unset. Core checks them where records are made, files saved and API
requests answered, refusing with `SCOPE_LIMIT_REACHED`, or 429 for requests.

Removing a tenant is deliberately two steps:

1. **Suspend.** The tenant resolves for nobody — its domains, prefix, members and API keys reach
   nothing — and every row it has stays where it is. **Resume** undoes it.
2. **Purge.** Asked for from the danger zone, with a fresh session and a typed confirmation, it
   waits (7 days by default) and can be called off until it runs. An export is offered first. The
   job then deletes every scoped row and every file carrying that tenant's value.

`scope.export` and `scope.import` in core move one tenant between instances, reusing the backup
archive format, so a tenant exported from one install serves the same site in another.

## 9. From the command line and from an agent

```sh
cms tenant list
cms tenant show <id>
cms tenant domains --tenant <id>
cms tenant suspend <id>
cms tenant resume <id>
cms tenant export <id> --out tenant.archive
cms tenant import <id> --in tenant.archive
```

`tansy doctor` gains this plugin's own checks. The agent tools — list tenants, describe one, list its
domains and members, suspend and resume — work in the tenant the caller is in and cannot ask for
another's. Purging is not something an agent can do: a person asks for it in the dashboard.

## 10. Security

- Isolation is enforced **in core's record layer, before grants and rules**. Out-of-scope rows are
  "denied", so a plugin hook, an owner's rule or a forgotten query cannot leak another tenant's
  data.
- Another tenant's record, file, slug or domain answers with the same **404** as something that does
  not exist. Existence is never revealed.
- Every Kysely query passes through one scope plugin that adds the value to `WHERE` and join
  conditions, sets it on insert and refuses to change it. Raw SQL naming a record table is limited
  to a reviewed list that a unit test holds. System tables go through a client that throws when no
  tenant is set, unless the call is wrapped in `unscoped("reason")`, which a contract test lists.
- Resolution hints never widen access. Switching tenant with `ext.multi-tenant:all` is audited.
- The organization plugin's endpoints are closed to HTTP, its tables are system-owned, and its role
  checks use core's role map, so a member cannot promote themselves by editing their own membership.
- A cross-tenant test matrix calls **every route in the access manifest** with tenant A's session,
  key, header, cookie and domain against tenant B's ids, and every answer must be 404 or 403. New
  routes join the matrix because they join the manifest. Core also runs it against a minimal example
  scope plugin (`examples/workspaces`), so the mechanism is proven without this plugin.
- Rate limits apply per tenant as well as per caller.

## 11. Turning it on and off

Installing the plugin creates the first tenant, `default`, and core backfills the scope column on
existing rows with it, in batches, in maintenance mode, recorded in `SchemaMigration`. Nothing moves
for a single-site owner.

To take it out again, turn each scoped collection's scope mode off first, on its Schema page: core
allows that only while the collection's records all belong to **one** tenant, and otherwise refuses
with `409 SCOPE_VALUES_REMAIN`. Until that is done, a scoped collection with the plugin gone has no
tenant to read in and answers `400 SCOPE_REQUIRED` — core will not show two tenants' rows together
by accident. One plugin per install may provide a scope; a second one stops startup.

## 12. Limits to know

- **A theme's options are the same for every tenant.** A tenant picks which of the installed themes
  serves its site, under **Site**, but a theme's `options` are set in `tansy.config.ts`, so its
  tagline and the like are the instance's. Themes have no stored options yet.
- **The block editor's canvas shows blocks in the default theme**, there being one editor for the
  instance. A tenant's own pages are served in the theme it chose.
- **A tenant with no verified domain has no feed of its own.** Feed routes and the API are served at
  the root, never under a path prefix, so such a tenant's feed links come from the instance's.
- A path prefix must be typed literally. A percent-encoded first segment does not match and is a
  404.
- No database or schema per tenant, and no collections, fields or blocks for one tenant only.
- One pool of users: the same email address is one person with several memberships, never two
  people.
- better-auth's dynamic roles and teams are not used. Roles come from **Dashboard → Roles**.
- Plugins and themes are installed in code, so they cannot be installed per tenant from the
  dashboard.
- No billing. Limits exist; charging for them is a payments plugin's business.
- A record cannot be moved between tenants. Export and import instead.
- Postgres row-level security is not used as a further layer, because SQLite has none and both
  databases must behave the same.
