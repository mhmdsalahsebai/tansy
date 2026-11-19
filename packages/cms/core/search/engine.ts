import type { SearchAdapter } from "./types";

/**
 * What search adapters share, such as @tansy/search-meilisearch. Core keeps everything
 * engines have in common: what is indexed, the queue and retries, rebuilding, and applying
 * the collection's rules to results. An adapter only turns each call into one API request.
 */

/** Types an adapter. */
export const defineSearchAdapter = (adapter: SearchAdapter): SearchAdapter => adapter;

/**
 * An engine refused or failed a request. Only the status reaches the message and the
 * logs: an engine's answer can quote the API key, the query or a record's text.
 */
export class SearchEngineError extends Error {
  constructor(readonly engine: string, readonly status: number | null) {
    super(status ? `${engine} answered ${status}` : `${engine} couldn't be reached`);
    this.name = "SearchEngineError";
  }
}

const TIMEOUT_MS = 10_000;

export interface EngineCall {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Usually JSON. */
  body?: string;
  /** Statuses that count as success with no answer, such as 404 when removing something already gone. */
  allow?: number[];
}

/**
 * Calls an engine's API and returns its JSON answer, or `{}` when it has none. Times out
 * after 10 seconds and never follows a redirect. Anything else but a 2xx throws a
 * `SearchEngineError` with only the status.
 */
export async function callEngine(engine: string, url: string | URL, { allow = [], ...init }: EngineCall = {}, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SearchEngineError(engine, null);
  }
  if (!response.ok) {
    // Read and dropped, so the connection can be reused. What it said stays out of logs.
    await response.body?.cancel().catch(() => {});
    if (allow.includes(response.status)) return {};
    throw new SearchEngineError(engine, response.status);
  }
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    throw new SearchEngineError(engine, response.status);
  }
}

/**
 * An engine's base address, without a trailing slash. Only http and https, and no user
 * or password in it: keys go in a header, where they can't end up in a log of addresses.
 */
export function engineUrl(engine: string, value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${engine} needs the address of its server, such as https://search.example.com.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${engine}'s address must start with https:// or http://.`);
  if (url.username || url.password) throw new Error(`${engine}'s address can't hold a user or password. Pass the API key on its own.`);
  if (url.search || url.hash) throw new Error(`${engine}'s address can't have a query or fragment.`);
  return url.href.replace(/\/+$/, "");
}

/**
 * The document's id in the engine: one per record, or per record and language. Letters,
 * digits, `-` and `_` only, which every engine accepts.
 */
export function documentId(collectionId: number, recordId: number, locale?: string) {
  const base = `${collectionId}_${recordId}`;
  return locale ? `${base}_${locale.replace(/[^A-Za-z0-9-]/g, "")}` : base;
}

/** Record ids from an engine's hits, in order, each once, and never more than `limit`. Anything that isn't a positive whole number is dropped. */
export function recordIds(hits: unknown, limit: number, pick: (hit: Record<string, unknown>) => unknown = (hit) => hit.recordId): number[] {
  if (!Array.isArray(hits)) return [];
  const ids = new Set<number>();
  for (const hit of hits) {
    if (ids.size >= limit) break;
    const id = hit && typeof hit === "object" ? Number(pick(hit as Record<string, unknown>)) : NaN;
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** Puts a value in double quotes for a filter expression, for engines that read one. */
export const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;
