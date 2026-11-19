import { describe, expect, it } from "vitest";
import { callEngine, documentId, engineUrl, recordIds, SearchEngineError } from "@/core/search/engine";
import type { SearchAdapter } from "@/core/search/types";
import { algolia } from "../../plugins/search-algolia/index";
import { meilisearch } from "../../plugins/search-meilisearch/index";
import { typesense } from "../../plugins/search-typesense/index";

interface Sent { method: string; url: URL; headers: Headers; body: unknown }

/** A fetch that records each request and answers from `reply`. */
function engine(reply: (request: Sent) => Response = () => Response.json({})) {
  const sent: Sent[] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    expect(init.redirect).toBe("error");
    const request = { method: init.method ?? "GET", url: new URL(String(input)), headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(request);
    return reply(request);
  }) as typeof fetch;
  return { sent, fetcher };
}

describe("engine helpers", () => {
  it("give each record and language its own id", () => {
    expect(documentId(3, 41)).toBe("3_41");
    expect(documentId(3, 41, "pt-BR")).toBe("3_41_pt-BR");
    expect(documentId(3, 41, "x\"/../y")).toBe("3_41_xy");
  });
  it("take only positive whole record ids, each once, up to the limit", () => {
    expect(recordIds([{ recordId: 5 }, { recordId: "7" }, { recordId: 5 }, { recordId: -1 }, { recordId: 1.5 }, null, { recordId: 9 }], 3)).toEqual([5, 7, 9]);
    expect(recordIds("nope", 10)).toEqual([]);
  });
  it("refuse addresses that hide credentials or aren't http", () => {
    expect(engineUrl("X", "https://search.example.com/")).toBe("https://search.example.com");
    for (const bad of ["ftp://a.example", "https://user:pass@a.example", "not a url", "https://a.example/?q=1", undefined]) expect(() => engineUrl("X", bad), String(bad)).toThrow();
  });
  it("report only the status, never what the engine said", async () => {
    const { fetcher } = engine(() => new Response("bad key sk_live_123 for record text", { status: 403 }));
    const error = await callEngine("Meilisearch", "https://a.example", {}, fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchEngineError);
    expect(String(error)).toBe("SearchEngineError: Meilisearch answered 403");
    expect(String(error)).not.toContain("sk_live");
  });
  it("treat allowed statuses as an empty answer", async () => {
    const { fetcher } = engine(() => new Response("missing", { status: 404 }));
    await expect(callEngine("X", "https://a.example", { allow: [404] }, fetcher)).resolves.toEqual({});
  });
  it("say an unreachable engine is unreachable", async () => {
    const fetcher = (async () => { throw new TypeError("fetch failed: connect ECONNREFUSED"); }) as typeof fetch;
    await expect(callEngine("Typesense", "https://a.example", {}, fetcher)).rejects.toThrow("Typesense couldn't be reached");
  });
});

/** The calls core makes, in the order the queue makes them. */
async function exercise(adapter: SearchAdapter) {
  await adapter.setup?.();
  await adapter.index({ collectionId: 2, recordId: 8, text: "hello world" });
  await adapter.index({ collectionId: 2, recordId: 8, text: "bonjour", locale: "fr" });
  await adapter.remove(2, 8, "fr");
  await adapter.remove(2, 8);
  await adapter.removeCollection(2);
}

describe("Meilisearch", () => {
  it("keeps every collection in one index, filtered by collection, record and language", async () => {
    const { sent, fetcher } = engine();
    await exercise(meilisearch({ host: "http://127.0.0.1:7700/", apiKey: "key", index: "site" }, fetcher));
    expect(sent.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`)).toEqual([
      "PATCH /indexes/site/settings",
      "POST /indexes/site/documents?primaryKey=id",
      "POST /indexes/site/documents?primaryKey=id",
      "DELETE /indexes/site/documents/2_8_fr",
      "POST /indexes/site/documents/delete",
      "POST /indexes/site/documents/delete",
    ]);
    expect(sent[0].body).toMatchObject({ filterableAttributes: ["collectionId", "recordId", "locale", "scope"] });
    expect(sent[1].body).toEqual([{ id: "2_8", collectionId: 2, recordId: 8, text: "hello world" }]);
    expect(sent[2].body).toEqual([{ id: "2_8_fr", collectionId: 2, recordId: 8, text: "bonjour", locale: "fr" }]);
    expect(sent[4].body).toEqual({ filter: "collectionId = 2 AND recordId = 8" });
    expect(sent[5].body).toEqual({ filter: "collectionId = 2" });
    expect(sent.every((request) => request.headers.get("authorization") === "Bearer key")).toBe(true);
  });
  it("searches one collection and language, returning record ids best first", async () => {
    const { sent, fetcher } = engine(() => Response.json({ hits: [{ recordId: 9 }, { recordId: 4 }] }));
    const adapter = meilisearch({ host: "https://search.example.com", index: "site" }, fetcher);
    expect(await adapter.search(2, "hel", 20, "fr")).toEqual([9, 4]);
    expect(sent[0].body).toEqual({ q: "hel", filter: 'collectionId = 2 AND locale = "fr"', limit: 20, attributesToRetrieve: ["recordId"] });
    expect(sent[0].headers.has("authorization")).toBe(false);
  });
  it("keeps a scope value's documents apart", async () => {
    const { sent, fetcher } = engine(() => Response.json({ hits: [] }));
    const adapter = meilisearch({ host: "https://search.example.com", index: "site" }, fetcher);
    await adapter.index({ collectionId: 2, recordId: 8, text: "hi", scope: "acme" });
    await adapter.search(2, "hi", 20, undefined, "acme");
    expect(sent[0].body).toEqual([{ id: "2_8", collectionId: 2, recordId: 8, text: "hi", scope: "acme" }]);
    expect(sent[1].body).toMatchObject({ filter: 'collectionId = 2 AND scope = "acme"' });
  });
  it("finds nothing in an index that doesn't exist yet", async () => {
    const { fetcher } = engine(() => new Response(null, { status: 404 }));
    expect(await meilisearch({ host: "https://search.example.com" }, fetcher).search(1, "x", 10)).toEqual([]);
  });
  it("names its target, so moving it rebuilds the index", () => {
    expect(meilisearch({ host: "https://a.example", index: "one" }).target).not.toBe(meilisearch({ host: "https://a.example", index: "two" }).target);
  });
  it("refuses an index name that could change the address", () => expect(() => meilisearch({ host: "https://a.example", index: "../keys" })).toThrow(/index name/));
});

describe("Typesense", () => {
  it("creates its collection once and filters deletes by collection and record", async () => {
    const { sent, fetcher } = engine((request) => (request.url.pathname === "/collections" ? new Response(null, { status: 409 }) : Response.json({})));
    await exercise(typesense({ host: "http://127.0.0.1:8108", apiKey: "key", collection: "site" }, fetcher));
    expect(sent.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "POST /collections",
      "PATCH /collections/site",
      "POST /collections/site/documents",
      "POST /collections/site/documents",
      "DELETE /collections/site/documents/2_8_fr",
      "DELETE /collections/site/documents",
      "DELETE /collections/site/documents",
    ]);
    expect(sent[1].body).toEqual({ fields: [{ name: "scope", type: "string", optional: true }] });
    expect(sent[2].url.searchParams.get("action")).toBe("upsert");
    expect(sent[2].body).toEqual({ id: "2_8", collectionId: 2, recordId: 8, text: "hello world" });
    expect(sent[5].url.searchParams.get("filter_by")).toBe("collectionId:=2 && recordId:=8");
    expect(sent[6].url.searchParams.get("filter_by")).toBe("collectionId:=2");
    expect(sent.every((request) => request.headers.get("x-typesense-api-key") === "key")).toBe(true);
  });
  it("pages through results up to the limit", async () => {
    const { sent, fetcher } = engine((request) => {
      const page = Number(request.url.searchParams.get("page"));
      const size = Number(request.url.searchParams.get("per_page"));
      return Response.json({ hits: Array.from({ length: page === 1 ? size : 3 }, (_, index) => ({ document: { recordId: (page - 1) * 250 + index + 1 } })) });
    });
    const ids = await typesense({ host: "https://ts.example.com", apiKey: "key" }, fetcher).search(2, "hel", 300, "fr");
    expect(ids).toHaveLength(253);
    expect(sent[0].url.searchParams.get("filter_by")).toBe("collectionId:=2 && locale:=`fr`");
    expect(sent.map((request) => request.url.searchParams.get("per_page"))).toEqual(["250", "50"]);
    await typesense({ host: "https://ts.example.com", apiKey: "key" }, fetcher).search(2, "hel", 1, undefined, "acme");
    expect(sent.at(-1)!.url.searchParams.get("filter_by")).toBe("collectionId:=2 && scope:=`acme`");
  });
});

describe("Algolia", () => {
  it("writes to the application's write host and reads from its search host", async () => {
    const { sent, fetcher } = engine(() => Response.json({ hits: [{ recordId: 3 }] }));
    const adapter = algolia({ appId: "ABC123", apiKey: "key", index: "site" }, fetcher);
    await exercise(adapter);
    expect(await adapter.search(2, "hel", 5000, "fr")).toEqual([3]);
    expect(sent.map((request) => `${request.method} ${request.url.host}${request.url.pathname}`)).toEqual([
      "PUT abc123.algolia.net/1/indexes/site/settings",
      "PUT abc123.algolia.net/1/indexes/site/2_8",
      "PUT abc123.algolia.net/1/indexes/site/2_8_fr",
      "DELETE abc123.algolia.net/1/indexes/site/2_8_fr",
      "POST abc123.algolia.net/1/indexes/site/deleteBy",
      "POST abc123.algolia.net/1/indexes/site/deleteBy",
      "POST abc123-dsn.algolia.net/1/indexes/site/query",
    ]);
    expect(sent[4].body).toEqual({ filters: "collectionId=2 AND recordId=8" });
    expect(sent[6].body).toMatchObject({ query: "hel", filters: 'collectionId=2 AND locale:"fr"', hitsPerPage: 1000 });
    expect(sent.every((request) => request.headers.get("x-algolia-api-key") === "key" && request.headers.get("x-algolia-application-id") === "ABC123")).toBe(true);
  });
  it("refuses an application id that would pick another host", () => {
    for (const appId of ["evil.example.com/x", "a@b", ""]) expect(() => algolia({ appId, apiKey: "key" }), appId).toThrow(/application id/);
  });
});
