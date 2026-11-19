# Search

Mark fields **Searchable**, then query `/records?search=words`. Out of the box, search runs in the database: FTS5 on SQLite and full-text search on Postgres, with one entry per language in a localized collection. Nothing else is needed.

For typo tolerance, ranking you can tune, or a large site, hand search to an outside engine. Three adapters ship:

| Package | Engine |
|---|---|
| `@tansy/search-meilisearch` | Meilisearch, self-hosted or Meilisearch Cloud |
| `@tansy/search-typesense` | Typesense, self-hosted or Typesense Cloud |
| `@tansy/search-algolia` | Algolia |

## Set it up

Install one and set `search` in `tansy.config.ts`:

```ts
import { meilisearch } from "@tansy/search-meilisearch";

export default defineCms({
  // ...
  search: meilisearch({ host: process.env.MEILISEARCH_HOST!, apiKey: process.env.MEILISEARCH_API_KEY, index: "tansy" }),
});
```

```ts
import { typesense } from "@tansy/search-typesense";
search: typesense({ host: process.env.TYPESENSE_HOST!, apiKey: process.env.TYPESENSE_API_KEY!, collection: "tansy" }),
```

```ts
import { algolia } from "@tansy/search-algolia";
search: algolia({ appId: process.env.ALGOLIA_APP_ID!, apiKey: process.env.ALGOLIA_API_KEY!, index: "tansy" }),
```

The starter picks one from `MEILISEARCH_HOST`, `TYPESENSE_HOST` or `ALGOLIA_APP_ID` (see `.env.example`).

The key needs to search, write and delete documents, and change the index's settings. It stays on the server: browsers search through `/records?search=`, never the engine. For Algolia, make a key with `search`, `addObject`, `deleteObject`, `deleteIndex` and `editSettings` limited to the index, not the search-only key.

On the next start, the CMS creates the index and its settings, then sends it every record. **Changing engine, host or index name does the same into the new one**, and going back to no engine rebuilds the database's own index, which isn't kept up while an engine is set. After `tansy restore`, the next start rebuilds the engine's index too, since it still holds what was written after the backup.

## How it stays in step

- Every create, update, delete, translation and schema change notes the record in a queue, `cms_search_queue`, inside the same transaction as the write. A write never waits on the engine and never fails because of it.
- After the write commits, the queue reads the record as it is then and sends it. Several changes to one record send it once. The queue holds ids, never a record's text.
- If the engine is down or refuses, the change is tried again after 5 seconds, then 30, 2 minutes, 10 minutes, half an hour, and every hour after that, until it goes through. Nothing is dropped, and a restart picks up where it stopped. Errors are logged with the status only.
- Results can be a few seconds behind writes. Meilisearch and Algolia also apply writes in the background on their side.

## What an engine sees and decides

- It receives the text of fields marked **Searchable**, joined into one `text` attribute, plus the record's collection id, record id and, for a localized collection, language. Hidden fields are never sent, as with the built-in index.
- It decides only which record ids match, up to 1,000. The collection's list rule, filters, sort and paging still apply to those ids, so an engine can never show a caller a record they couldn't list. Results are sorted by the request's `sort`, not by the engine's ranking.
- A localized collection searches only the requested language's documents, so words from a translation the reader doesn't get can't make a record appear.

## Write your own

Implement `SearchAdapter` from `tansy/search`. Each method is one request to the engine. `tansy/search` also has the pieces the shipped adapters use:

| Export | What it does |
|---|---|
| `defineSearchAdapter` | Types an adapter |
| `callEngine(engine, url, init, fetch)` | Sends a request with a 10-second timeout and no redirects. Anything but a 2xx, or a status listed in `allow`, throws a `SearchEngineError` holding only the status |
| `engineUrl(engine, value)` | Checks an address: http or https, no user, password, query or fragment |
| `documentId(collectionId, recordId, locale?)` | The document's id, the same in every engine |
| `recordIds(hits, limit, pick?)` | Record ids from hits, in order, each once, positive whole numbers only |
| `quoted(value)` | A value in double quotes for a filter |

```ts
import { callEngine, defineSearchAdapter, documentId, recordIds } from "tansy/search";

export const myEngine = (base: string, key: string) => defineSearchAdapter({
  name: "my-engine",
  target: `my-engine:${base}`,            // a change rebuilds the index
  async setup() { /* create the index, make collectionId, recordId and locale filterable */ },
  async index({ collectionId, recordId, text, locale }) { /* upsert documentId(collectionId, recordId, locale) */ },
  async remove(collectionId, recordId, locale) { /* one language, or every language of the record */ },
  async removeCollection(collectionId) { /* every document of the collection */ },
  async search(collectionId, query, limit, locale) {
    const answer = await callEngine("My engine", `${base}/search`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ query, collectionId, locale, limit }) });
    return recordIds(answer.hits, limit);
  },
});
```

The contract:

- `remove` and `removeCollection` succeed when there is nothing to remove, since the queue may repeat them.
- `remove` without `locale` removes every language's document for the record.
- `search` returns at most `limit` record ids, best first, from documents in `locale` only when one is given. `query` is plain letters and digits, the last word possibly unfinished.
- Throw on any failure. The queue retries.
- Never put an engine's answer in an error: it can quote keys or records.

## Limits

- One engine at a time, for every collection.
- Results come back in the request's sort order, not the engine's ranking.
- No dashboard page for the queue yet. Failures are in the server log, and `SELECT * FROM cms_search_queue` shows what is waiting.
