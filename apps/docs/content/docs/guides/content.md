---
title: "Working with content"
description: "Paths below are relative to packages/cms. This covers importing records, the trash, and how files are described."
---

Paths below are relative to `packages/cms`. This covers importing records, the trash, and how files are described.

## Importing records

**Dashboard → Collections → (a collection) → Import** brings records in from a CSV or JSON file.
The page reads the file, shows which column goes to which field, checks every row without writing
anything, and then imports.

```sh
# The same thing for a script. dryRun checks and writes nothing.
curl -X POST "$SITE/api/collections/12/import" -H 'content-type: application/json' \
  -d '{"csv":"title,slug\nHello,hello","status":"draft","dryRun":true}'
```

- **CSV**: a header row names the columns. Commas, semicolons and tabs all work, and a quoted cell
  may hold commas, newlines and doubled quotes. A column whose name matches a field is mapped for
  you; anything else has to be mapped or left out, so a typo is never silently dropped.
- **JSON**: `rows` holds a list of objects whose keys are column names, with values already typed.
  The dashboard reads a `.json` file holding a list, or one object per line, into the same thing.
- **Cells become values**: numbers, `true`/`false`/`yes`/`no`/`1`/`0`, dates any `Date` can read,
  record ids for a reference (`7`, or `7, 9` for several), file ids for an image or a file, and JSON
  for a JSON field. An empty cell is no value, so a blank column doesn't overwrite a default.
- **Matching existing records**: choose a unique field. A row whose value is already there updates
  that record; everything else is added. This needs `record:update` as well as `record:create`.
- **Every row is a save.** Validation, `record.before*` and `record.after*` hooks, history, the
  search index, webhooks and the review gate all apply, so an import can't put in anything the
  editor couldn't. Published rows in a collection that requires review need `record:publish`.
- **When a row fails** the result names the row, the field and what was wrong. "Stop there" (the
  default) leaves the rows already written in place and reports how many weren't reached; "skip it
  and go on" imports the rest.

### Limits to know

- At most 2,000 rows per request, and 12 MB of body. A larger file goes in several requests.
- Each row is its own transaction, so an import that stops partway has written the rows before it.
  There is no undo for an import; the rows it added can be deleted, and a delete goes to the trash.
- No files are uploaded. An image or file column names ids that are already in the library.
- A stream field has to come in as JSON, which a spreadsheet can't really write. Blocks are better
  made in the editor or through the records API.
- `?locale=` imports one language of a localized collection, the default language otherwise. Rows
  fill that language's fields and the record's shared ones.
- API rules don't open an import: it needs the record permissions, as a schema import does.

## The trash

Deleting a record doesn't end it. Every delete — from the dashboard, the records API, `/api/batch`,
MCP, a plugin's `records.delete` — writes an entry to the trash in the delete's own transaction, and
**Dashboard → Content → Trash** lists what can be put back.

Putting a record back gives it **its own id again**, so links to it, bookmarks and the addresses of
its files all still match. It comes back with:

- its values, as they were live, and all of its translations;
- its status, draft or published;
- the reference fields in other records that pointed at it, where nothing has filled them since.

It does **not** come back with its revision history or a draft that was pending when it was deleted.
A restore starts a fresh history, with "Restored from the trash" as its first entry.

### Who can put a record back

`record:delete` for the collection. Whoever could delete the record could already have chosen not to,
and a restore is less destructive than the delete they were allowed, so no extra permission exists for
it. An own grant (`record:delete@c3:own`) covers only the entries of records that person created.

Where a collection requires review, a record that was published when it was deleted needs
`record:publish` to come back, because it goes live again. Someone without it gets `REVIEW_REQUIRED`;
the record can still be put back by a reviewer.

### Retention

**Dashboard → Settings → Security → Trash** sets how long entries are kept (30 days by default) and
can turn the trash off, which makes deletes permanent as they were before. Housekeeping removes
entries past their retention each hour, and on a host without timers each time
`/api/background` runs ([background work](/docs/guides/background-work)).

Removing an entry by hand — **Delete for good** on the trash page, or
`DELETE /api/collections/:id/trash/:trashId` — can't be undone.

### Files

A file a trashed record used can't be deleted from the library while that record can still come back:
the library answers `409` and names the reason. So a record never comes back without its images.

Two things to know:

- A trashed record's files aren't readable through it. Only a live record's links grant file access, so
  an image whose only record is in the trash is private until the record is back.
- A restore re-checks each field's limits (`maxSize`, `allowedTypes`). If a field's limits have
  tightened since the delete, the restore is refused with an error on that field; widen the limit, or
  restore and then change the value.

### What a restore sets off

To everything downstream the record is new again: `record.afterCreate` hooks run, webhooks fire for a
create, realtime subscribers get a `create` event, and the search index is written. A site's read
cache is cleared by that event like any other write.

### Tenants

An entry belongs to the scope value its record did, so one tenant's trash holds only its own records,
and purging a tenant removes its entries with the rest of its rows (multi-tenancy).

### Limits to know

- The trash holds the record as it was live. History and pending drafts go with the delete.
- A record whose id has since been taken by a new record can't be put back (`RECORD_ID_TAKEN`).
  Ids are never reused by the database, so this only happens after an import that chose ids.
- At most 1,000 cleared inbound links are remembered per record. A record linked from more than that
  comes back with the first 1,000 links restored.
- A list of references loses the position the id had: it goes back at the end of the list.
- Links from inside a block are not affected either way: a record can't be deleted while a block links
  to it, which hasn't changed.
- Fields the collection no longer has are dropped on the way back, as they are when restoring a
  revision. A field that has become required since the delete refuses the restore until it has a value.

## Describing files

Every file can carry three pieces of text: **alternative text** (what an image shows, for a reader
who can't see it), a **caption** and a **credit**. Set them in **Dashboard → Content → Files**, with
**Describe**, or beside an image field in the editor, where authors are.

```sh
# Or through the API, for an import or a script.
curl -X PATCH "$SITE/api/files/$ID/text" -H 'content-type: application/json' \
  -d '{"alt":"A grey cat asleep","credit":"Ada"}'
```

### How it reaches a page

A record carries the text of the files it uses, under `files`, keyed by file id:

```json
{ "id": 12, "title": "Hello", "cover": "mGQ…", "files": { "mGQ…": { "alt": "A grey cat asleep", "caption": "", "credit": "" } } }
```

So a theme needs no read of its own. In a template, `fileText(id)` gives the same three strings:

```tsx
<img src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} />
```

Only files in fields the reader may see are included, so a hidden field's images say nothing. A file
on its own is also readable at `GET /api/files/:id/info`, which answers to whoever may read the file.

### Languages

Text is kept per language. The default language's words are the file's own, and every other
language holds only what has been written for it; each of the three strings falls back along the
site's language chain on its own, as a localized field does. The **Describe** box has a language
chooser on a site with more than one language, and the API takes `"locale": "fr"`.

Clearing a word removes it for that language, so it falls back again rather than showing nothing.

### Who may describe a file

`file:update` describes any file. Whoever uploaded a file may describe theirs without it, since they
can already read it; to anyone else the file answers as missing — so authors can label their own uploads. A role seeded before this existed
doesn't have `file:update`: add it under **Roles**.

### Limits to know

- Alternative text is not in XLIFF, so a translator works on it in the dashboard or through the API,
  not in a translation file.
- A theme's client-side thumbnails that sit beside their own heading, such as a search result's,
  stay decorative (`alt=""`). The text is in the record payload if a theme wants it there.
- A file's text isn't versioned. Changing it changes what every page using that file says.

## Where a picture is cropped

A thumbnail that has to crop, such as `100x100` or a card's cover, keeps the middle of the picture
unless the file says otherwise. A **focal point** says where the subject is, so a face stays in
frame at every size.

Set it in **Describe**, by clicking the picture or typing the two percentages, or through the API:

```sh
# Percentages from the left and from the top. null puts it back in the middle.
curl -X PATCH "$SITE/api/files/$ID/focus" -H 'content-type: application/json' \
  -d '{"focus":{"x":30,"y":70}}'
```

- **Thumbnails** core renders crop around the point, which is part of the thumbnail's key, so a new
  point is a new thumbnail rather than the old crop. A browser keeps one it already has for up to
  five minutes.
- **Themes** get the same point from `fileFocus(id)`, beside `fileText(id)`, as `objectPosition`
  ready for CSS. Use it wherever an image is cropped in the browser:

  ```tsx
  <img src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} style={{ objectPosition: fileFocus(cover).objectPosition }} />
  ```

  The middle is answered for a file with no point, so it is always safe to use. The `magazine` theme
  does this on its cards and article covers.
- **Records** carry the point beside the text, under `files`, so a headless front end gets it too.
- Whoever may describe a file may place its focal point. It is for images only.

### Limits to know

- An image service that makes thumbnails for a storage plugin (Cloudinary, Bunny) crops from the
  middle: core passes the point as `focus` in `ThumbnailOptions`, and those adapters don't use it yet.
  Core's own thumbnails, which includes local disk and S3, honour it.
- The point is not per language, and isn't versioned: it changes every page that crops the file.

## Replacing a file

A corrected picture doesn't need a new file. **Describe → Replace the file** sends new bytes under
the same id, so every record, block and address that already uses the file shows them.

```sh
curl -X PUT "$SITE/api/files/$ID/bytes" -H 'content-type: image/png' --data-binary @corrected.png
```

- The bytes go to a key of their own and the old ones, with their thumbnails, are removed, so nothing
  that cached the old key — a CDN, a signed URL — can serve what was replaced.
- The **type can't change kind**: an image takes another image, anything else takes its own type
  (`FILE_TYPE_CHANGED`). A field, a thumbnail and a theme all expect what was there before.
- Text and focal point stay as they are. Percentages hold for a picture of any size.
- It needs `file:update`, not just having uploaded the file: these bytes are published wherever the
  file is used, which is more than the uploader can see. Only a file of your own tenant, never one
  the whole instance shares.
- Pages that were cached hold the old width, height and type until their reads are read again
  (`TANSY_SITE_CACHE_SECONDS`, 30 seconds by default).

## What the library doesn't do

**Dashboard → Content → Files** lists every file with its text, its focal point and where it is
used, and that is the whole of it. Not built yet:

- **no folders and no tags.** Files are found by searching and by filtering on type and date.
- **no crop saved per use.** One focal point per file, applied wherever it is cropped.
- **no direct-to-bucket upload**, and no multipart upload for very large files. Bytes go through the
  server, so the size limit (50 MiB by default) also bounds its temporary disk use.

A record returns file ids, and a client builds addresses as `/api/files/<id>`, with `?thumb=100x100`,
`300x300` or `800x0`.

The rest of the CMS's boundaries are in [Limits and boundaries](/docs/guides/limits).
