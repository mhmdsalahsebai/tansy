import { callEngine, defineSearchAdapter, type EngineCall, documentId, quoted, recordIds } from "tansy/search";

export interface AlgoliaOptions {
  /** The application's id, from Algolia → Settings → API Keys. */
  appId: string;
  /**
   * A key with the search, addObject, deleteObject, deleteIndex and editSettings
   * rights, limited to this index. Never the search-only key: this one writes.
   */
  apiKey: string;
  /** Letters, digits, `-` and `_`. Created if missing. Defaults to "tansy". */
  index?: string;
}

const ENGINE = "Algolia";
const APP_ID = /^[A-Za-z0-9]{1,32}$/;
const INDEX_NAME = /^[A-Za-z0-9_-]{1,100}$/;
/** The most hits Algolia returns in one request. */
const MAX_HITS = 1000;

/**
 * Algolia, through its REST API. One index holds every collection, with each record's
 * collection and language as attributes to filter on.
 */
export function algolia({ appId, apiKey, index = "tansy" }: AlgoliaOptions, fetcher: typeof fetch = fetch) {
  // The id becomes part of a host name, so it can't be allowed to pick another one.
  if (!APP_ID.test(appId)) throw new Error(`${ENGINE} needs its application id: letters and digits only.`);
  if (!apiKey) throw new Error(`${ENGINE} needs an API key.`);
  if (!INDEX_NAME.test(index)) throw new Error(`${ENGINE}'s index name may hold only letters, digits, - and _.`);
  const headers = { "content-type": "application/json", "x-algolia-application-id": appId, "x-algolia-api-key": apiKey };
  const write = `https://${appId}.algolia.net/1/indexes/${index}`;
  const read = `https://${appId}-dsn.algolia.net/1/indexes/${index}`;
  const call = (url: string, init: EngineCall) => callEngine(ENGINE, url, { ...init, headers }, fetcher);
  // Algolia applies an index's writes in the order they arrive.
  const deleteWhere = (filters: string) => call(`${write}/deleteBy`, { method: "POST", body: JSON.stringify({ filters }), allow: [404] });

  return defineSearchAdapter({
    name: "algolia",
    target: `algolia:${appId}/${index}`,
    async setup() {
      // Creates the index too. Numbers filter without being facets, but the language needs to be one.
      await call(`${write}/settings`, { method: "PUT", body: JSON.stringify({ searchableAttributes: ["text"], attributesForFaceting: ["filterOnly(locale)", "filterOnly(scope)"], attributesToRetrieve: ["recordId"] }) });
    },
    async index({ collectionId, recordId, text, locale, scope }) {
      const document = { collectionId, recordId, text, ...(locale ? { locale } : {}), ...(scope ? { scope } : {}) };
      await call(`${write}/${documentId(collectionId, recordId, locale)}`, { method: "PUT", body: JSON.stringify(document) });
    },
    async remove(collectionId, recordId, locale) {
      if (locale) await call(`${write}/${documentId(collectionId, recordId, locale)}`, { method: "DELETE", allow: [404] });
      else await deleteWhere(`collectionId=${collectionId} AND recordId=${recordId}`);
    },
    async removeCollection(collectionId) {
      await deleteWhere(`collectionId=${collectionId}`);
    },
    async search(collectionId, query, limit, locale, scope) {
      const filters = `collectionId=${collectionId}${locale ? ` AND locale:${quoted(locale)}` : ""}${scope ? ` AND scope:${quoted(scope)}` : ""}`;
      const hitsPerPage = Math.min(limit, MAX_HITS);
      // An index that doesn't exist yet has nothing to find.
      const answer = await call(`${read}/query`, {
        method: "POST",
        body: JSON.stringify({ query, filters, hitsPerPage, attributesToRetrieve: ["recordId"], attributesToHighlight: [], attributesToSnippet: [], analytics: false }),
        allow: [404],
      });
      return recordIds(answer.hits, hitsPerPage);
    },
  });
}
