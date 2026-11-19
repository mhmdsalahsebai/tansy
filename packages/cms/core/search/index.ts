import "server-only";
import { sql, type SqlBool, type Transaction } from "kysely";
import { getCmsConfig } from "../config";
import { DENY_ALL, type RuleFilter } from "../authz/rules/sql";
import { recordsDb } from "../content/db";
import { isPostgres } from "../../lib/prisma/kind";
import { postgresQuery, searchWords, sqliteQuery } from "./extract";
import { currentScopeValue } from "../scope/context";
import { scopedCollectionIds } from "../scope/registry";

/** The scope value an outside engine's search is for, on a scoped collection. The record query narrows to it anyway. */
const engineScope = (collectionId: number) => (scopedCollectionIds().has(collectionId) ? currentScopeValue() ?? undefined : undefined);

type Trx = Transaction<Record<string, Record<string, unknown>>>;

export const searchAdapter = () => getCmsConfig().search;

const ADAPTER_RESULT_LIMIT = 1000;
/** FTS5 can only look up rows quickly by rowid, so one holds both ids. */
const COLLECTION_SHIFT = 2 ** 32;
const rowid = (collectionId: number, recordId: number) => collectionId * COLLECTION_SHIFT + recordId;

/** Created here rather than in a Prisma migration, as Prisma would call an FTS5 table drift. */
export async function ensureSearchIndex() {
  if (isPostgres()) {
    await sql`CREATE TABLE IF NOT EXISTS cms_search (collection_id INTEGER NOT NULL, record_id INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection_id, record_id))`.execute(recordsDb);
    await sql`CREATE INDEX IF NOT EXISTS cms_search_body ON cms_search USING gin (to_tsvector('simple', body))`.execute(recordsDb);
    // Localized collections: one entry per record and language, stemmed in that language.
    await sql`CREATE TABLE IF NOT EXISTS cms_search_l (collection_id INTEGER NOT NULL, record_id INTEGER NOT NULL, locale TEXT NOT NULL, config regconfig NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection_id, record_id, locale))`.execute(recordsDb);
    await sql`CREATE INDEX IF NOT EXISTS cms_search_l_body ON cms_search_l USING gin (to_tsvector(config, body))`.execute(recordsDb);
  } else {
    await sql`CREATE VIRTUAL TABLE IF NOT EXISTS cms_search USING fts5(body, tokenize = 'unicode61')`.execute(recordsDb);
    // FTS5 finds rows quickly only by rowid, so a plain table maps each entry to its record and language.
    await sql`CREATE TABLE IF NOT EXISTS cms_search_lk (id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL, record_id INTEGER NOT NULL, locale TEXT NOT NULL, words TEXT NOT NULL, UNIQUE (collection_id, record_id, locale))`.execute(recordsDb);
    await sql`CREATE VIRTUAL TABLE IF NOT EXISTS cms_search_lw USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')`.execute(recordsDb);
    // Chinese, Japanese, Korean and Thai have no spaces between words, so they match by any three characters.
    await sql`CREATE VIRTUAL TABLE IF NOT EXISTS cms_search_lt USING fts5(body, tokenize = 'trigram')`.execute(recordsDb);
  }
  // Changes waiting for an outside engine. `record_id` 0 rebuilds the whole collection, and `locale`
  // is empty for a record without languages or for every language of one. `version` goes up with each
  // change, so a change made while one is being sent isn't dropped when that one finishes.
  await sql`CREATE TABLE IF NOT EXISTS cms_search_queue (collection_id INTEGER NOT NULL, record_id INTEGER NOT NULL, locale TEXT NOT NULL, version INTEGER NOT NULL, attempts INTEGER NOT NULL, due_at BIGINT NOT NULL, error TEXT, PRIMARY KEY (collection_id, record_id, locale))`.execute(recordsDb);
}

type Db = Trx | typeof recordsDb;

/**
 * Notes that a record, one of its languages, or with `recordId` 0 a whole collection, must be sent
 * to the outside engine again. Written in the change's own transaction, so a change that commits is
 * never lost, and one that rolls back sends nothing. The queue reads the record as it is when it runs.
 */
export async function queueSearch(db: Db, collectionId: number, recordId: number, locale = "") {
  const now = Date.now();
  await sql`INSERT INTO cms_search_queue (collection_id, record_id, locale, version, attempts, due_at) VALUES (${collectionId}, ${recordId}, ${locale}, 1, 0, ${now})
    ON CONFLICT (collection_id, record_id, locale) DO UPDATE SET version = cms_search_queue.version + 1, attempts = 0, due_at = ${now}, error = NULL`.execute(db);
}

/** Starts sending queued changes now, rather than at the next tick. Call after the change commits. */
export const wakeSearchQueue = () => void import("./sync").then(({ runSearchQueue }) => runSearchQueue()).catch((error) => console.error("[search]", error));

/** Languages written without spaces between words. */
const UNSPACED = new Set(["zh", "ja", "ko", "th", "lo", "km", "my"]);
const isUnspaced = (locale: string) => UNSPACED.has(locale.split("-")[0]);

/** Postgres's built-in text search configurations, by language subtag. Anything else is searched as `simple`. */
const POSTGRES_CONFIGS: Record<string, string> = {
  ar: "arabic", hy: "armenian", eu: "basque", ca: "catalan", da: "danish", nl: "dutch", en: "english", fi: "finnish", fr: "french",
  de: "german", el: "greek", hi: "hindi", hu: "hungarian", id: "indonesian", ga: "irish", it: "italian", lt: "lithuanian", ne: "nepali",
  nb: "norwegian", nn: "norwegian", no: "norwegian", pt: "portuguese", ro: "romanian", ru: "russian", sr: "serbian", es: "spanish",
  sv: "swedish", ta: "tamil", tr: "turkish", yi: "yiddish",
};

declare const globalThis: { cmsSearchConfigs?: Promise<Set<string>> } & typeof global;

/** The configurations this server has. Managed providers may leave some out. */
const installedConfigs = () => (globalThis.cmsSearchConfigs ??= sql<{ cfgname: string }>`SELECT cfgname FROM pg_ts_config`.execute(recordsDb).then((result) => new Set(result.rows.map((row) => row.cfgname))));

export async function searchConfig(locale: string) {
  const wanted = POSTGRES_CONFIGS[locale.split("-")[0]];
  return wanted && (await installedConfigs()).has(wanted) ? wanted : "simple";
}

/** Replaces one language's entry for a record. Empty text just removes it. */
export async function writeLocaleSearchEntry(trx: Trx, collectionId: number, recordId: number, locale: string, text: string) {
  if (searchAdapter()) return;
  await removeLocaleSearchEntry(trx, collectionId, recordId, locale);
  if (!text) return;
  if (isPostgres()) {
    await sql`INSERT INTO cms_search_l (collection_id, record_id, locale, config, body) VALUES (${collectionId}, ${recordId}, ${locale}, ${await searchConfig(locale)}::regconfig, ${text})`.execute(trx);
    return;
  }
  const words = isUnspaced(locale) ? "cms_search_lt" : "cms_search_lw";
  const inserted = await sql<{ id: number }>`INSERT INTO cms_search_lk (collection_id, record_id, locale, words) VALUES (${collectionId}, ${recordId}, ${locale}, ${words}) RETURNING id`.execute(trx);
  await sql`INSERT INTO ${sql.table(words)} (rowid, body) VALUES (${inserted.rows[0].id}, ${text})`.execute(trx);
}

/** Without `locale`, every language's entry. */
export async function removeLocaleSearchEntry(trx: Trx, collectionId: number, recordId: number, locale?: string) {
  if (searchAdapter()) return queueSearch(trx, collectionId, recordId, locale);
  if (isPostgres()) {
    await sql`DELETE FROM cms_search_l WHERE collection_id = ${collectionId} AND record_id = ${recordId} ${locale === undefined ? sql`` : sql`AND locale = ${locale}`}`.execute(trx);
    return;
  }
  const keys = await sql<{ id: number; words: string }>`SELECT id, words FROM cms_search_lk WHERE collection_id = ${collectionId} AND record_id = ${recordId} ${locale === undefined ? sql`` : sql`AND locale = ${locale}`}`.execute(trx);
  await removeSqliteKeys(trx, keys.rows);
}

async function removeSqliteKeys(trx: Trx | typeof recordsDb, keys: Array<{ id: number; words: string }>) {
  for (const words of ["cms_search_lw", "cms_search_lt"]) {
    const ids = keys.filter((key) => key.words === words).map((key) => key.id);
    for (let start = 0; start < ids.length; start += 500) {
      const part = ids.slice(start, start + 500);
      await sql`DELETE FROM ${sql.table(words)} WHERE rowid IN (${sql.join(part)})`.execute(trx);
      await sql`DELETE FROM cms_search_lk WHERE id IN (${sql.join(part)})`.execute(trx);
    }
  }
}

/** When a language's content is deleted for good. */
export async function removeLocaleSearchEntries(trx: Trx, locale: string) {
  if (searchAdapter()) {
    // An engine can't remove one language across a collection, so collections that had languages are rebuilt.
    const collections = await trx.selectFrom("Collection").select("id").where("localization", "is not", null).execute();
    for (const { id } of collections) await queueSearch(trx, id as number, 0);
    return;
  }
  if (isPostgres()) {
    await sql`DELETE FROM cms_search_l WHERE locale = ${locale}`.execute(trx);
    return;
  }
  const keys = await sql<{ id: number; words: string }>`SELECT id, words FROM cms_search_lk WHERE locale = ${locale}`.execute(trx);
  await removeSqliteKeys(trx, keys.rows);
}

async function clearLocaleSearch(collectionId: number) {
  if (isPostgres()) {
    await sql`DELETE FROM cms_search_l WHERE collection_id = ${collectionId}`.execute(recordsDb);
    return;
  }
  const keys = await sql<{ id: number; words: string }>`SELECT id, words FROM cms_search_lk WHERE collection_id = ${collectionId}`.execute(recordsDb);
  await removeSqliteKeys(recordsDb, keys.rows);
}

/**
 * A condition on a localized collection's read source. It pairs the record with the
 * language it is read in, so words from a translation the reader doesn't get, such
 * as a draft behind a published fallback, can't make a record appear.
 */
async function localeSearchWhere(collectionId: number, words: string[], locales: string[], requested: string): Promise<RuleFilter> {
  const adapter = searchAdapter();
  if (adapter) {
    const ids = await adapter.search(collectionId, words.join(" "), ADAPTER_RESULT_LIMIT, requested, engineScope(collectionId));
    return ids.length ? { where: sql<SqlBool>`("id" IN (${sql.join(ids)}) AND "locale" = ${requested})`, residual: [] } : DENY_ALL;
  }
  if (isPostgres()) {
    return { where: sql<SqlBool>`("id", "locale") IN (SELECT record_id, locale FROM cms_search_l WHERE collection_id = ${collectionId} AND locale IN (${sql.join(locales)}) AND to_tsvector(config, body) @@ to_tsquery(config, ${postgresQuery(words)}))`, residual: [] };
  }
  const spaced = locales.filter((locale) => !isUnspaced(locale));
  const unspaced = locales.filter(isUnspaced);
  const parts = [];
  if (spaced.length) parts.push(sql`SELECT k.record_id, k.locale FROM cms_search_lw JOIN cms_search_lk k ON k.id = cms_search_lw.rowid WHERE cms_search_lw MATCH ${sqliteQuery(words)} AND k.collection_id = ${collectionId} AND k.locale IN (${sql.join(spaced)})`);
  if (unspaced.length) parts.push(sql`SELECT k.record_id, k.locale FROM cms_search_lt JOIN cms_search_lk k ON k.id = cms_search_lt.rowid WHERE cms_search_lt MATCH ${sqliteQuery(words.map((word) => word))} AND k.collection_id = ${collectionId} AND k.locale IN (${sql.join(unspaced)})`);
  return { where: sql<SqlBool>`("id", "locale") IN (${sql.join(parts, sql` UNION `)})`, residual: [] };
}

export async function removeSearchEntry(trx: Trx, collectionId: number, recordId: number) {
  if (searchAdapter()) return queueSearch(trx, collectionId, recordId);
  if (isPostgres()) await sql`DELETE FROM cms_search WHERE collection_id = ${collectionId} AND record_id = ${recordId}`.execute(trx);
  else await sql`DELETE FROM cms_search WHERE rowid = ${rowid(collectionId, recordId)}`.execute(trx);
}

/** Replaces the record's entry. Empty text just removes it. */
export async function writeSearchEntry(trx: Trx, collectionId: number, recordId: number, text: string) {
  if (searchAdapter()) return;
  await removeSearchEntry(trx, collectionId, recordId);
  if (!text) return;
  if (isPostgres()) await sql`INSERT INTO cms_search (collection_id, record_id, body) VALUES (${collectionId}, ${recordId}, ${text})`.execute(trx);
  else await sql`INSERT INTO cms_search (rowid, body) VALUES (${rowid(collectionId, recordId)}, ${text})`.execute(trx);
}

/** With an outside engine, queues the collection to be rebuilt from what the database holds then, or removed if it's gone. */
export async function clearCollectionSearch(collectionId: number) {
  if (searchAdapter()) {
    await queueSearch(recordsDb, collectionId, 0);
    return wakeSearchQueue();
  }
  await clearLocaleSearch(collectionId);
  if (isPostgres()) await sql`DELETE FROM cms_search WHERE collection_id = ${collectionId}`.execute(recordsDb);
  else await sql`DELETE FROM cms_search WHERE rowid >= ${rowid(collectionId, 0)} AND rowid < ${rowid(collectionId + 1, 0)}`.execute(recordsDb);
}

/**
 * A condition on the record's id, to combine with the list rule. It can only narrow what the rule allows.
 * `locales` is set for a localized collection: the chain the read uses, nearest first.
 */
export async function searchWhere(collectionId: number, raw: string, locales?: string[]): Promise<RuleFilter> {
  const words = searchWords(raw);
  if (!words.length) return DENY_ALL;
  if (locales?.length) return localeSearchWhere(collectionId, words, locales, locales[0]);
  const adapter = searchAdapter();
  if (adapter) {
    const ids = await adapter.search(collectionId, words.join(" "), ADAPTER_RESULT_LIMIT, undefined, engineScope(collectionId));
    return ids.length ? { where: sql<SqlBool>`"id" IN (${sql.join(ids)})`, residual: [] } : DENY_ALL;
  }
  if (isPostgres()) {
    return { where: sql<SqlBool>`"id" IN (SELECT record_id FROM cms_search WHERE collection_id = ${collectionId} AND to_tsvector('simple', body) @@ to_tsquery('simple', ${postgresQuery(words)}))`, residual: [] };
  }
  const lowest = rowid(collectionId, 0);
  return { where: sql<SqlBool>`"id" IN (SELECT rowid - ${lowest} FROM cms_search WHERE cms_search MATCH ${sqliteQuery(words)} AND rowid >= ${lowest} AND rowid < ${rowid(collectionId + 1, 0)})`, residual: [] };
}
