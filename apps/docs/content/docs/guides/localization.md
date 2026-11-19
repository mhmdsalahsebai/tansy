---
title: "Many languages"
description: "Localization is part of core, not a plugin. One record holds every translation of itself, each language is published on its own, and the dashboard, the site and the API all speak whichever language is asked for.…"
---

Localization is part of core, not a plugin. One record holds every translation of itself, each
language is published on its own, and the dashboard, the site and the API all speak whichever
language is asked for. Paths below are relative to `packages/cms`.

A site with one language pays nothing for this. Nothing changes, and no data moves, until an owner
adds a second language and marks a collection localized.

Four separate things get translated, and they are set up in four different places:

| Layer | What it covers | Where it is set up |
|---|---|---|
| Content | Record values: titles, slugs, rich text, blocks, files that differ per market | **Languages**, then a collection's schema |
| Site | Addresses, `<html lang dir>`, `hreflang`, the theme's own words | **Languages → Routing** and **Site text** |
| Admin | The dashboard, plugin screens, the mail someone is sent | Each person's **Account** |
| Formatting | Dates, numbers, lists, sorting | `Intl`, from whichever language is in use |

## Adding a language

**Dashboard → Languages** lists the languages content can be written in. Each row has:

- a **code**, in BCP 47: `en`, `fr-CA`, `ar`, `zh-Hant`. It is checked against
  `Intl.getCanonicalLocales` and a stricter pattern (`language[-Script][-Region]`, 35 characters at
  most). A code is stored in every translation row, so **it can never change**. A wrong code is
  fixed by adding the right one and copying the content across;
- a **label** shown to editors and visitors, filled in with the language's own name;
- a **fallback**, the next language to try when this one has nothing published. A chain is at most
  four languages long and may not loop; saving one that would is refused;
- a **direction**, `ltr` or `rtl`, filled in from the language itself and editable;
- **public** or not. A language that isn't public can be written by editors but never reaches the
  API or the site, which is how a translation is prepared before anyone sees it.

One of them is the **default language**, which is a setting rather than a column, so there is always
exactly one. Changing it is a setting change, not a migration. The first language a new install has
is `en`, or `TANSY_DEFAULT_LOCALE` if that is set, and a one-language site behaves exactly as it did
before this feature existed.

Removing a language **hides** it. Its translations stay in the database until someone deletes them
deliberately, which asks for confirmation and writes an audit entry. Language changes need
`setting:update` and are all audited (`locale.create`, `locale.update`, `locale.delete`,
`locale.purge`).

`GET /api/locales` is public and lists the public languages, for a front end that builds its own
language switcher.

## Localizing a collection

Two switches, both on a collection's **Schema** page:

1. **Languages** on the collection. This creates a companion table, `loc_<slug>`, holding one row
   per record and language, and copies each record's `status` and `publishedAt` into its
   default-language row.
2. **Localized** on each field that differs per language. The field's column moves to the companion
   table, every record's current value is copied into its default-language row, and its unique index
   moves with it. Fields you leave alone are **shared**: one value for every language, which is
   where a price, a stock count or an internal note belongs.

Both run as one transaction through the schema service with a `SchemaMigration` entry, like any
other field change. Unmarking a field asks which language's value to keep and is lossy, so it needs
the same confirmation as a lossy type change. `PUT /api/collections/:id/localization` is the same
thing from a script.

A record keeps **one id** in every language. Links, permissions, file addresses, revisions,
webhooks, realtime and `/api/collections/:slug/records/:id` all keep working untouched, which is the
reason for storing translations this way rather than making a copy of the record per language.

Two more settings per collection:

- **Fallback**: `chain` (the default) follows each language's fallback chain; `none` means a record
  with nothing in the language asked for does not exist in that language. Legal pages usually want
  `none`.
- **Field fallback**: fills an empty localized field from the next published language in the chain.
  Off by default, because a page that mixes two languages surprises visitors.

`locale` is a reserved field name. A collection that already has a field called `locale` cannot be
localized until it is renamed; startup says so and `tansy doctor` reports it.

### Unique values and addresses

A unique localized field is unique **per language**, so two languages can both have a record at
`/about` while no two French records share a slug. A value that must be unique across every language
belongs in a shared field. URL patterns match the language's own values, so a French record can have
a French slug.

## Which translation a visitor sees

> The **effective translation** is the first language in the chain with a published row. If none is
> published, it is the first language in the chain with any row. Its `status` and values are the
> record's, for that request.

That one rule is what every read follows, so rules keep their meaning: `status = "published"` means
"published in the language being read", and a French draft beside a published English row shows the
English one. With nothing published, the rule hides the record, exactly as it would in a
single-language collection.

Every response carries `locale`, the language actually served, so a list can mark a record "not yet
translated". Responses also carry a `Content-Language` header.

Reading is the same across every surface — lists, single records, `GET /api/resolve`, `expand`,
realtime, `/api/batch`, agent tools, MCP and the site reader — because they all decide access with
`authorizeRecord` or `decideRecord` on the effective translation. No path reads a `loc_` row around
it.

```sh
# One language, with the collection's fallback chain.
curl "$SITE/api/collections/posts/records?locale=fr-CA"

# This language only: a record with no published French row isn't there.
curl "$SITE/api/collections/posts/records?locale=fr&fallback=none"

# Every language the caller may see, each localized field as a map.
curl "$SITE/api/collections/posts/records/12?locale=*"
```

- An unknown or hidden language is `400 INVALID_LOCALE` rather than a silent fallback, so a typo in
  a front end shows up at once. A bad `fallback` is `400 INVALID_FALLBACK`.
- A collection that isn't localized ignores `locale` but still refuses an unknown code, so a site
  can send the parameter to every collection.
- `?locale=*` puts each localized field through its own language's rules, and leaves out a language
  the caller may not read. Hidden fields stay hidden in every language.
- Filters, sorts and `@collection` lookups apply to the effective translation's values. Expanded
  records are read in the same language with the same chain.
- In rules, `@request.locale` is the language asked for and `locale` the one served, so a rule can
  keep a language to members while it is being prepared.
- Realtime subscriptions take `?locale=`, and each event is checked against each subscriber's own
  effective translation.
- Text sorts with the language's ICU collation on Postgres where the server has it
  (`fr-CA-x-icu`, then `fr-x-icu`); otherwise, and on SQLite, in the database's own order. Only
  localized collections sort this way, so adding a language never reorders a list that existed
  before.
- Search is indexed per translation, with the language's own text configuration (`french`,
  `german`, `arabic`, `simple` where there is none) on Postgres and FTS5 on SQLite, with trigrams
  for Chinese, Japanese, Korean and Thai. A search only ever matches each record's effective
  translation, so a word that exists only in a draft cannot make a record appear.

The typed SDK takes a language per call, or once for a client:

```ts
const fr = client.withLocale("fr");
const posts = await fr.collection("posts").list({ perPage: 10 });
```

Generated types keep a localized field's own type for a single-language read, and give the
`Localized<T>` and `…AllLocales` shapes for `?locale=*`. The OpenAPI document describes both.

## Writing a translation

```sh
curl -X PATCH "$SITE/api/collections/posts/records/12?locale=fr" \
  -H 'content-type: application/json' \
  -d '{"title":"Lancement","slug":"lancement","status":"published"}'
```

- **Create** makes the record and one translation, in the language asked for or the default one.
- **Update** writes localized values to that language's row, creating it if it isn't there, and
  shared values to the record itself. `status`, `publishedAt`, the pending draft, the revision
  history and any schedule all belong to the language, so French can go live on Monday and German on
  Friday. One revision covers the whole save.
- **Validation** runs per translation: a required localized field must be filled in the language
  being saved, and other languages need not exist.
- **Delete** removes the record in every language.
  `DELETE /api/collections/:id/content/:recordId/translations/:locale` removes one translation, and
  refuses the last one left.
- **Hooks, events and webhooks** all carry `locale`, and `record.afterUpdate`'s `previous` is the
  same translation as it was before the write.
- **Outdated translations.** Saving a translation stores a hash of each source value. When the
  source changes afterwards, those fields are marked outdated in the grid and the editor. Nothing is
  blocked; it is a flag, not a gate.

### Who may write which language

| Permission | What it allows |
|---|---|
| `locale:edit` | Writing content in any language |
| `locale:edit@fr` | Writing content in French only |

A localized value needs the record permission **and** the language's permission. A **shared** value
needs edit rights on the default language, so a translator cannot change a price or a hero image that
every language shows. Roles that already had a record write permission were granted `locale:edit`
when the feature landed, so nobody lost access.

There is a **Translator** role preset: read and update records, plus `locale:edit@<code>` for the
languages you pick.

## The editor and the grid

On a record's form:

- a language switcher, with the source language shown read-only beside the field being translated;
- outdated fields marked;
- **Copy from …** to start a translation from another language;
- **Translate with …** for each plugin that provides a translator;
- shared fields shown as shared, and locked for a translator.

In the record grid, each record carries a badge per language — missing, draft, published, outdated —
and the list can be narrowed to, say, everything missing in German. Those two parameters,
`?translations=1` and `?translation=de:missing`, are staff-only: whether a draft exists in a
language is itself unpublished information.

Publishing, unpublishing and scheduling all work per language, with one action for "publish every
language that is ready".

## Machine translation

Core defines the extension point and walks the record; the vendor is always a plugin. Any plugin
declaring `translator` appears under **Translate with …**. Core takes the record apart into segments
— text, rich text nodes, Markdown, every block in a stream, custom field types' own text — sends
only localized, readable, non-hidden text, and puts the result into the form **unsaved**, so an
editor reviews it before it is written. The call is audited as `record.translate` with the languages
and field names, never the text.

The AI plugin is the first translator. Writing another is a few lines: see "Translators" in
[Extending Tansy](/docs/extending).

## XLIFF, for agencies and tools

XLIFF 2.0 is in core, so content can go out to a translation tool or an agency and come back.

```sh
# Export: one language pair, optionally particular records.
curl "$SITE/api/collections/7/translations/xliff?from=en&to=fr&ids=12,13" -o posts-en-fr.xlf

# Import: the file comes back as French drafts.
curl -X POST "$SITE/api/collections/7/translations/xliff" \
  -H 'content-type: application/json' --data-binary @body.json
```

- Export needs `record:read` and lists each record's text in the source language beside whatever the
  target language already has. At most 500 records per file.
- Import goes through the normal write path, so it needs `record:update` and `locale:edit`, runs
  validation and hooks, and writes history. It **refuses any segment whose source has changed since
  the export**, and reports per record what was saved, left as a draft or skipped.
- Both are audited, as `translation.export` and `translation.import`.

## Streams in several languages

A localized stream is localized whole by default: each language has its own blocks, which lets a
translation differ in shape, as marketing pages often need.

A stream field can instead be marked **Same blocks in every language** (`synced`). Then the default
language owns the blocks and their order, and a translation holds only the text of each block, by
block id, in text, rich text and nested stream fields. The editor shows a translation the default
language's blocks with adding, moving and removing turned off, every save is lined up with the
default language on the server, and saving the default language realigns the others, so a new block
reaches every language untranslated. Turning the option on realigns every record, so it is a
destructive schema change and asks for confirmation.

## The site

**Dashboard → Languages → Routing** chooses how an address names its language:

| Mode | Addresses |
|---|---|
| `prefix` (default) | `/fr/blog/x`. The default language has no prefix unless **Prefix the default language** is on |
| `domains` | A host per language, such as `fr.example.com` |
| `none` | One language per site address |

A prefix that names no language, or a hidden one, is just an ordinary first path segment.

**Detect at the root** is off by default. With it on, a first-time visitor arriving at `/` — and
only at `/` — is sent to the language their browser asks for, remembered in a cookie. Deep links are
never redirected by browser language: crawlers send none, and people share links across languages.

What the site layer does with that:

- `GET /api/resolve` takes the language from the prefix or the host, matches URL patterns against
  that language's values, and returns `locale` plus `alternates`, the same record's address in every
  public language it is published in. A record found only in another language is a redirect only when
  the caller may view it there, and otherwise does not exist.
- `SiteReader` and `loadSitePage` take a language, `tansy/server` passes it on, `CmsClient` sends
  it, and the site read cache is keyed by language.
- `<ThemedPage>` sets `lang` and `dir`, and a theme gets a language switcher built from `alternates`.
- The SEO plugin writes `hreflang` and `x-default` alternates and a sitemap with `xhtml:link` per
  language. The blog plugin serves a feed per language.
- Menus are localized singletons, so each language gets its own with nothing new to learn. A
  redirect is offered when a localized slug changes.

### The theme's own words

A theme declares its words per language in ICU MessageFormat, and gets `t()`, `formatDate` and
`formatNumber` in `TemplateProps`:

```ts
defineTheme({
  messages: {
    en: { readMore: "Read more", page: "Page {n} of {total}" },
    ar: { readMore: "اقرأ المزيد", page: "صفحة {n} من {total}" },
  },
});
```

An owner can change any of those words per language under **Languages → Site text**, validated as
ICU and never as HTML. First-party plugins ship their public words the same way, layered under the
theme's and the owner's, so a theme or an owner can word a plugin's page differently. `blank` and
`blog` ship English and Arabic. Themes written before this keep working: without words, parts fall
back to English. See [Themes](/docs/guides/themes) and "Words on a site" in
[Extending Tansy](/docs/extending).

## The dashboard in another language

Each person picks their interface language under **Account**. It is stored on their profile and
mirrored in an HttpOnly cookie, so the root layout can set `<html lang dir>` with no database read,
sign-in pages included. Without a choice it falls back to the cookie, then `Accept-Language`, then
the instance default.

- Every dashboard page is translated, the stream and rich-text editors and the file and reference
  pickers included. Dates, numbers and relative times are formatted with `Intl` in that language.
- The dashboard turns right to left for a language that reads that way: the CSS is logical
  throughout, and a unit test fails on a physical property.
- API errors carry a stable `code`, and the dashboard shows a translated message for it. `message`
  stays English for API callers.
- Collection names, block labels, field labels, descriptions and choice labels all take a value per
  interface language, edited on each one's schema page, so a mixed team sees its own words.
- Account email goes out in the recipient's chosen language, or the instance default — never a
  browser's, which a sender cannot know.
- **English and Arabic** ship with core and with every first-party plugin and theme. Arabic is there
  because right-to-left proves the layout. More languages arrive as catalogs in the repository,
  checked in CI for missing keys and invalid ICU.

A plugin ships its own words as `messages` and reads them through the same `useT()`: see "The
dashboard in other languages" in [Extending Tansy](/docs/extending).

## Limits to know

- **A record per language, with its own id, is not how this works** and will not be. One record
  holds every translation of itself. Moving to the other model would re-point every link and
  permission between siblings.
- Settings other than site text are not localized, and neither are user fields or roles.
- Prices and currencies per market are not a localization feature. Prices stay shared fields; a
  shop that needs per-market pricing models it as data.
- Nothing is translated automatically on save. Machine translation is always a suggestion an editor
  saves.
- A visitor's language is detected at `/` only, never on a deep link.
- The dashboard's own interface strings cannot be edited from the dashboard. Catalogs are code, as
  plugins and themes are. An owner can change the **site's** words, not the admin's.
- A localized collection's reads add a join. A collection with one language has none at all.
- XLIFF files hold at most 500 records each.
- Emails to staff — a shop order notice, a comment notice — stay English, like the rest of a
  plugin's staff-facing text outside the dashboard. Email to customers and learners follows their
  own language.
