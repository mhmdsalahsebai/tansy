import { callEngine, defineSearchAdapter, type EngineCall, documentId, engineUrl, quoted, recordIds } from "tansy/search";

export interface MeilisearchOptions {
  /** The server's address, such as https://search.example.com or http://127.0.0.1:7700. */
  host: string;
  /** A key allowed to search, add and delete documents, and change the index's settings. The master key works but gives more than that. */
  apiKey?: string;
  /** Letters, digits, `-` and `_`. Created if missing. Defaults to "tansy". */
  index?: string;
}

const ENGINE = "Meilisearch";
const INDEX_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Meilisearch, through its REST API. One index holds every collection, with each
 * document's collection, record and language as filterable attributes.
 */
export function meilisearch({ host, apiKey, index = "tansy" }: MeilisearchOptions, fetcher: typeof fetch = fetch) {
  const base = engineUrl(ENGINE, host);
  if (!INDEX_NAME.test(index)) throw new Error(`${ENGINE}'s index name may hold only letters, digits, - and _.`);
  const indexUrl = `${base}/indexes/${index}`;
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const call = (path: string, init: EngineCall) => callEngine(ENGINE, `${indexUrl}${path}`, { ...init, headers }, fetcher);
  // Writes are queued tasks in Meilisearch, run in order per index, so a delete sent before an add is applied first.
  const deleteWhere = (filter: string) => call("/documents/delete", { method: "POST", body: JSON.stringify({ filter }), allow: [404] });

  return defineSearchAdapter({
    name: "meilisearch",
    target: `meilisearch:${base}/${index}`,
    async setup() {
      // Creates the index too, when it doesn't exist.
      await call("/settings", {
        method: "PATCH",
        body: JSON.stringify({ searchableAttributes: ["text"], filterableAttributes: ["collectionId", "recordId", "locale", "scope"], displayedAttributes: ["recordId"] }),
      });
    },
    async index({ collectionId, recordId, text, locale, scope }) {
      const document = { id: documentId(collectionId, recordId, locale), collectionId, recordId, text, ...(locale ? { locale } : {}), ...(scope ? { scope } : {}) };
      await call("/documents?primaryKey=id", { method: "POST", body: JSON.stringify([document]) });
    },
    async remove(collectionId, recordId, locale) {
      if (locale) await call(`/documents/${documentId(collectionId, recordId, locale)}`, { method: "DELETE", allow: [404] });
      else await deleteWhere(`collectionId = ${collectionId} AND recordId = ${recordId}`);
    },
    async removeCollection(collectionId) {
      await deleteWhere(`collectionId = ${collectionId}`);
    },
    async search(collectionId, query, limit, locale, scope) {
      const filter = `collectionId = ${collectionId}${locale ? ` AND locale = ${quoted(locale)}` : ""}${scope ? ` AND scope = ${quoted(scope)}` : ""}`;
      // An index that doesn't exist yet has nothing to find.
      const answer = await call("/search", { method: "POST", body: JSON.stringify({ q: query, filter, limit, attributesToRetrieve: ["recordId"] }), allow: [404] });
      return recordIds(answer.hits, limit);
    },
  });
}
