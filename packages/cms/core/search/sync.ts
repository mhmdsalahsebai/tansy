import "server-only";
import { sql } from "kysely";
import prisma from "../../lib/prisma";
import { recordsDb } from "../content/db";
import { collectionSearchEntries, recordSearchEntries, type SearchEntry } from "../content/content-service";
import type { CollectionWithFields } from "../content/access";
import { queueSearch, searchAdapter } from ".";
import type { SearchAdapter } from "./types";

/**
 * Sends the changes `queueSearch` noted to the outside engine. Each one is read from the
 * database as it is now, so several changes to a record send it once, and nothing written
 * to the queue holds a record's text. A change that fails is tried again later, for as
 * long as it takes: the engine must end up matching the database.
 */

/** Seconds before each retry. The last repeats. */
const RETRY_DELAYS = [5, 30, 120, 600, 1800, 3600];
const BATCH = 50;
const MAX_ERROR = 500;
/** The engine the database was last indexed into, in AppSetting. "builtin" for the database's own index. */
export const SEARCH_ENGINE_KEY = "search.engine";

interface Queued { collection_id: number; record_id: number; locale: string; version: number; attempts: number }

interface QueueState { running: boolean; again: boolean; ready: SearchAdapter | null }
declare const globalThis: { cmsSearchQueue?: QueueState } & typeof global;
const state: QueueState = (globalThis.cmsSearchQueue ??= { running: false, again: false, ready: null });

export const engineTarget = (adapter: SearchAdapter | undefined) => (adapter ? adapter.target ?? adapter.name : "builtin");

const loadCollection = (id: number) => prisma.collection.findUnique({ where: { id }, include: { fields: { orderBy: { id: "asc" } } } }) as Promise<CollectionWithFields | null>;

async function send(adapter: SearchAdapter, collectionId: number, entries: SearchEntry[]) {
  for (const { recordId, locale, text, scope } of entries) {
    if (text) await adapter.index({ collectionId, recordId, text, ...(locale === undefined ? {} : { locale }), ...(scope === undefined ? {} : { scope }) });
    else await adapter.remove(collectionId, recordId, locale);
  }
}

async function rebuild(adapter: SearchAdapter, collectionId: number) {
  await adapter.removeCollection(collectionId);
  const collection = await loadCollection(collectionId);
  if (!collection) return;
  for await (const entry of collectionSearchEntries(collection)) await send(adapter, collectionId, [entry]);
}

async function apply(adapter: SearchAdapter, item: Queued) {
  if (item.record_id === 0) return rebuild(adapter, item.collection_id);
  const collection = await loadCollection(item.collection_id);
  // A deleted collection has its own rebuild queued, which removes it.
  if (!collection) return adapter.remove(item.collection_id, item.record_id);
  const entries = await recordSearchEntries(collection, item.record_id, item.locale || undefined);
  if (entries) await send(adapter, item.collection_id, entries);
  else await adapter.remove(item.collection_id, item.record_id);
}

/** Only the status or a short reason, never what the engine said back, which can quote keys or records. */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR);

async function attempt(adapter: SearchAdapter, item: Queued) {
  const where = sql`collection_id = ${item.collection_id} AND record_id = ${item.record_id} AND locale = ${item.locale}`;
  try {
    if (state.ready !== adapter) {
      await adapter.setup?.();
      state.ready = adapter;
    }
    await apply(adapter, item);
    // Left in place if it changed meanwhile, so that change is sent too.
    await sql`DELETE FROM cms_search_queue WHERE ${where} AND version = ${item.version}`.execute(recordsDb);
    return true;
  } catch (error) {
    const delay = RETRY_DELAYS[Math.min(item.attempts, RETRY_DELAYS.length - 1)];
    if (item.attempts >= 2) console.error(`[search] ${adapter.name} failed ${item.attempts + 1} times:`, reason(error));
    await sql`UPDATE cms_search_queue SET attempts = attempts + 1, due_at = ${Date.now() + delay * 1000}, error = ${reason(error)} WHERE ${where} AND version = ${item.version}`.execute(recordsDb);
    return false;
  }
}

/**
 * Sends what is due. Called after each write commits and on a timer for retries. A call
 * while it runs makes it look again once it finishes. Stops at the first failure, since
 * the engine is most likely down, and leaves the rest to the timer.
 */
export async function runSearchQueue() {
  const adapter = searchAdapter();
  if (!adapter) return;
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  try {
    do {
      state.again = false;
      for (;;) {
        // Rebuilds first, so a record's change isn't sent and then wiped by its collection's rebuild.
        const due = (await sql<Queued>`SELECT collection_id, record_id, locale, version, attempts FROM cms_search_queue WHERE due_at <= ${Date.now()} ORDER BY record_id = 0 DESC, due_at, collection_id, record_id LIMIT ${BATCH}`.execute(recordsDb)).rows
          .map((row) => ({ ...row, collection_id: Number(row.collection_id), record_id: Number(row.record_id), version: Number(row.version), attempts: Number(row.attempts) }));
        if (!due.length) break;
        for (const item of due) if (!(await attempt(adapter, item))) return;
        if (due.length < BATCH) break;
      }
    } while (state.again);
  } finally {
    state.running = false;
  }
}

/**
 * At startup. When the engine differs from the one the database was last indexed into, the
 * new one gets every collection, so records written before it was set up can be found. Going
 * back to the database's own index rebuilds that, since it wasn't kept up meanwhile.
 */
export async function prepareSearch() {
  const adapter = searchAdapter();
  const target = engineTarget(adapter);
  const stored = await prisma.appSetting.findUnique({ where: { key: SEARCH_ENGINE_KEY } });
  const previous = typeof stored?.value === "string" ? stored.value : null;
  if (previous === target) return;
  // A database that never had an engine was indexed by itself.
  if (previous === null && !adapter) {
    await prisma.appSetting.create({ data: { key: SEARCH_ENGINE_KEY, value: target } });
    return;
  }
  const collections = await prisma.collection.findMany({ where: { type: { not: "view" } }, select: { id: true } });
  if (adapter) {
    await recordsDb.transaction().execute(async (trx) => {
      for (const { id } of collections) await queueSearch(trx, id, 0);
    });
  } else {
    await sql`DELETE FROM cms_search_queue`.execute(recordsDb);
    const { reindexCollection } = await import("../content/content-service");
    void (async () => {
      for (const { id } of collections) {
        const collection = await loadCollection(id);
        if (collection) await reindexCollection(collection);
      }
    })().catch((error) => console.error("[search] rebuilding the database's index failed", error));
  }
  await prisma.appSetting.upsert({ where: { key: SEARCH_ENGINE_KEY }, create: { key: SEARCH_ENGINE_KEY, value: target }, update: { value: target } });
  console.info(`[search] indexing every collection into ${adapter ? adapter.name : "the database"}`);
}
