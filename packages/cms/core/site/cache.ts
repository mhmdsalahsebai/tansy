import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a same-app site has read as a signed-out visitor.
 *
 * Pages can't be cached whole, because each carries a per-request CSP nonce, so this
 * caches the reads under them instead. Only `tansy/server` writes here, and it never
 * takes a session, cookie or header, so every visitor would get the same answer.
 * Anything a viewer's identity could change, previews included, stays out.
 *
 * Each entry remembers which collections its read actually touched, registered by the
 * lowest level that names a record table (`trackCollectionRead`), so the set is complete
 * however a read got there: its own collection, the ones `expand` crossed, the ones a rule
 * read through `@collection`, and the one a relation filter followed. A record write then
 * drops the entries that read that collection and leaves the rest alone, which is what
 * keeps a cache worth having on a site whose comments or orders are written all day.
 * Anything broader — a schema, settings, language, redirect or file change — drops
 * everything, because those can change any read. The time limit still covers what no
 * event announces, such as a rule comparing a field with `@now`.
 *
 * Only built-in imports, because the realtime hub and event emitter call this on every write.
 */
interface Entry {
  json: string;
  expires: number;
  /** The collections this read touched, so a write to one of them can find this entry. */
  collections: number[];
}

interface CacheState {
  generation: number;
  entries: Map<string, Entry>;
  /** Keys by collection, the other way round, so invalidating one doesn't walk every entry. */
  byCollection: Map<number, Set<string>>;
  bytes: number;
}

declare const globalThis: { cmsSiteCache?: CacheState } & typeof global;

// On globalThis because Next.js gives routes and instrumentation separate copies of a module.
const state: CacheState = (globalThis.cmsSiteCache ??= { generation: 0, entries: new Map(), byCollection: new Map(), bytes: 0 });
// A copy of this module from an earlier build may have left a state without the index.
state.byCollection ??= new Map();

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const ttlMs = () => {
  const seconds = Number(process.env.TANSY_SITE_CACHE_SECONDS);
  return (Number.isFinite(seconds) && process.env.TANSY_SITE_CACHE_SECONDS !== undefined ? Math.max(seconds, 0) : 30) * 1000;
};

/**
 * The reads in progress, innermost last. A list rather than one set, so a read that runs
 * inside another registers in both and neither ends up with less than it depended on.
 */
const reading = new AsyncLocalStorage<Array<Set<number>>>();

/**
 * Registers that the read in progress read from this collection. Does nothing outside one,
 * which is every write and every request that isn't a cached site read.
 */
export function trackCollectionRead(id: number) {
  const open = reading.getStore();
  if (open) for (const touched of open) touched.add(id);
}

/** What a cached read touched, for tests and for anything that needs to see the dependency. */
export const trackedCollections = () => reading.getStore()?.at(-1);

function unindex(key: string, collections: number[]) {
  for (const id of collections) {
    const keys = state.byCollection.get(id);
    if (!keys) continue;
    keys.delete(key);
    if (!keys.size) state.byCollection.delete(id);
  }
}

function forget(key: string) {
  const entry = state.entries.get(key);
  if (!entry) return;
  state.entries.delete(key);
  state.bytes -= entry.json.length;
  unindex(key, entry.collections);
}

/**
 * Call once a change is committed. With a collection, only the reads that touched it go;
 * without one, everything does, which is right for a change that any read could show.
 */
export function invalidateSiteCache(what?: { collection?: number }) {
  // Bumped either way, so a read that was already running when the write landed isn't kept.
  state.generation++;
  const id = what?.collection;
  if (id === undefined) {
    state.entries.clear();
    state.byCollection.clear();
    state.bytes = 0;
    return;
  }
  for (const key of [...(state.byCollection.get(id) ?? [])]) forget(key);
}

function store(key: string, json: string, expires: number, collections: Set<number>) {
  forget(key);
  state.entries.set(key, { json, expires, collections: [...collections] });
  state.bytes += json.length;
  for (const id of collections) {
    const keys = state.byCollection.get(id) ?? new Set<string>();
    keys.add(key);
    state.byCollection.set(id, keys);
  }
  // A Map keeps insertion order, and a hit re-inserts, so the first key is the least recently used.
  while (state.entries.size > MAX_ENTRIES || state.bytes > MAX_TOTAL_BYTES) forget(state.entries.keys().next().value as string);
}

/**
 * Serves from the cache or runs `load`. Always returns a fresh JSON copy, which means
 * this reader gives exactly what the HTTP API would, and a template can't change what the
 * next visitor sees.
 */
export async function cachedRead<T>(parts: unknown[], load: () => Promise<T>): Promise<T> {
  const ttl = ttlMs();
  const key = JSON.stringify(parts);
  const now = Date.now();
  if (ttl > 0) {
    const hit = state.entries.get(key);
    if (hit && hit.expires > now) {
      state.entries.delete(key);
      state.entries.set(key, hit);
      return JSON.parse(hit.json) as T;
    }
  }
  const started = state.generation;
  const touched = new Set<number>();
  // Tracked even with the cache off, so turning it off can't change what a read reports.
  const json = JSON.stringify(await reading.run([...(reading.getStore() ?? []), touched], load));
  // Anything written while this read ran may be missing from it, so it isn't kept.
  if (ttl > 0 && state.generation === started && json.length <= MAX_ENTRY_BYTES) store(key, json, now + ttl, touched);
  return JSON.parse(json) as T;
}
