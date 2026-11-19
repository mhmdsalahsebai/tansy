import { callEngine, defineSearchAdapter, type EngineCall, documentId, engineUrl, recordIds } from "tansy/search";

export interface TypesenseOptions {
  /** The server's address, such as https://xyz.a1.typesense.net or http://127.0.0.1:8108. */
  host: string;
  /** A key allowed to search, write and delete documents, and create the collection. */
  apiKey: string;
  /** Letters, digits, `-` and `_`. Created if missing. Defaults to "tansy". */
  collection?: string;
}

const ENGINE = "Typesense";
const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,100}$/;
/** The most hits Typesense returns in one page. */
const PAGE = 250;

/**
 * Typesense, through its REST API. One Typesense collection holds every CMS collection,
 * with each document's collection, record and language as fields to filter on.
 */
export function typesense({ host, apiKey, collection = "tansy" }: TypesenseOptions, fetcher: typeof fetch = fetch) {
  const base = engineUrl(ENGINE, host);
  if (!apiKey) throw new Error(`${ENGINE} needs an API key.`);
  if (!COLLECTION_NAME.test(collection)) throw new Error(`${ENGINE}'s collection name may hold only letters, digits, - and _.`);
  const headers = { "content-type": "application/json", "x-typesense-api-key": apiKey };
  const documents = `${base}/collections/${collection}/documents`;
  const call = (url: string, init: EngineCall) => callEngine(ENGINE, url, { ...init, headers }, fetcher);
  const deleteWhere = (filter: string) => call(`${documents}?${new URLSearchParams({ filter_by: filter })}`, { method: "DELETE", allow: [404] });

  return defineSearchAdapter({
    name: "typesense",
    target: `typesense:${base}/${collection}`,
    async setup() {
      // 409 when it already exists. Its fields are left as they are.
      await call(`${base}/collections`, {
        method: "POST",
        allow: [409],
        body: JSON.stringify({
          name: collection,
          fields: [
            { name: "collectionId", type: "int32" },
            { name: "recordId", type: "int32" },
            { name: "locale", type: "string", optional: true },
            { name: "scope", type: "string", optional: true },
            { name: "text", type: "string" },
          ],
        }),
      });
      // Collections made before scopes existed get the field. 400 when it is there already.
      await call(`${base}/collections/${collection}`, { method: "PATCH", allow: [400], body: JSON.stringify({ fields: [{ name: "scope", type: "string", optional: true }] }) });
    },
    async index({ collectionId, recordId, text, locale, scope }) {
      const document = { id: documentId(collectionId, recordId, locale), collectionId, recordId, text, ...(locale ? { locale } : {}), ...(scope ? { scope } : {}) };
      await call(`${documents}?action=upsert`, { method: "POST", body: JSON.stringify(document) });
    },
    async remove(collectionId, recordId, locale) {
      if (locale) await call(`${documents}/${documentId(collectionId, recordId, locale)}`, { method: "DELETE", allow: [404] });
      else await deleteWhere(`collectionId:=${collectionId} && recordId:=${recordId}`);
    },
    async removeCollection(collectionId) {
      await deleteWhere(`collectionId:=${collectionId}`);
    },
    async search(collectionId, query, limit, locale, scope) {
      // Locales and scope values are letters, digits, hyphens and underscores, so a backquoted one can't end the filter early.
      const filter = `collectionId:=${collectionId}${locale ? ` && locale:=\`${locale.replace(/[^A-Za-z0-9-]/g, "")}\`` : ""}${scope ? ` && scope:=\`${scope.replace(/[^A-Za-z0-9_-]/g, "")}\`` : ""}`;
      const ids: number[] = [];
      for (let page = 1; ids.length < limit; page++) {
        const perPage = Math.min(PAGE, limit - ids.length);
        const params = new URLSearchParams({ q: query, query_by: "text", filter_by: filter, include_fields: "recordId", per_page: String(perPage), page: String(page), prefix: "true" });
        // A collection that doesn't exist yet has nothing to find.
        const answer = await call(`${documents}/search?${params}`, { method: "GET", allow: [404] });
        const hits = Array.isArray(answer.hits) ? answer.hits : [];
        for (const id of recordIds(hits, perPage, (hit) => (hit.document as Record<string, unknown> | undefined)?.recordId)) if (!ids.includes(id)) ids.push(id);
        if (hits.length < perPage) break;
      }
      return ids.slice(0, limit);
    },
  });
}
