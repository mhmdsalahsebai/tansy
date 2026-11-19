import "server-only";
import { sql, type RawBuilder, type Transaction } from "kysely";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";
import { recordsDb } from "../content/db";
import { fieldStorage } from "../fields/registry";
import { localeTableName, tableName } from "../schema/names";
import { rawScopeColumn, rawScopeCondition } from "../scope/plugin";
import * as ddl from "../schema/ddl";
import { localizationOf, localizedFields, sharedFields, type CollectionLocale, type WithLocale } from "./context";
import { localeCatalog, type LocaleCatalog } from "./locales";
import { trackCollectionRead } from "../site/cache";

type Trx = Transaction<Record<string, Record<string, unknown>>>;

interface Field {
  id: number;
  name: string;
  type: string;
  config: unknown;
  storage?: string | null;
}

export interface LocalizableCollection {
  id: number;
  slug: string;
  type: string;
  localization?: unknown;
  fields: Field[];
}

/**
 * The languages a read uses when its caller named none: the default first, then
 * every other language, so internal work such as schedules and plugin reads finds
 * a record written in any language. Rules still decide on the translation chosen.
 */
export function anyLocale(catalog: LocaleCatalog): CollectionLocale {
  return { code: catalog.defaultLocale, chain: [catalog.defaultLocale, ...catalog.locales.map((locale) => locale.code).filter((code) => code !== catalog.defaultLocale)], missing: "absent" };
}

/** A read for an API request: the language asked for, with its fallbacks unless the collection or the request turns them off. */
export function readLocale(collection: { localization?: unknown }, catalog: LocaleCatalog, code: string, fallback?: "none" | "chain"): CollectionLocale {
  const config = localizationOf(collection);
  const chained = config?.fallback !== "none" && fallback !== "none";
  return { code, chain: chained ? catalog.chain(code) : [code], missing: "absent" };
}

/** A write to one language. A record with no translation in it yet reads with empty localized values. */
export const writeLocale = (code: string): CollectionLocale => ({ code, chain: [code], missing: "empty" });

export function withLocale<C extends { localization?: unknown }>(collection: C, locale: CollectionLocale): WithLocale<C> {
  return localizationOf(collection) ? { ...collection, locale } : collection;
}

/** The language a localized collection is read in, filling in the default for callers that named none. */
export async function effectiveLocale(collection: WithLocale<{ localization?: unknown }>): Promise<CollectionLocale | null> {
  if (!localizationOf(collection)) return null;
  return collection.locale ?? anyLocale(await localeCatalog());
}

declare const globalThis: { cmsCollations?: Promise<Set<string>> } & typeof global;

/** The ICU collations this Postgres server has. Managed providers may leave them out. */
const icuCollations = () => (globalThis.cmsCollations ??= sql<{ collname: string }>`SELECT collname FROM pg_collation WHERE collprovider = 'i'`
  .execute(recordsDb)
  .then((result) => new Set(result.rows.map((row) => row.collname)), () => new Set<string>()));

/**
 * The collation that sorts text in the language a localized collection is read in, such
 * as "fr-x-icu", or null for the database's own order. SQLite sorts by code point.
 */
export async function sortCollation(collection: WithLocale<{ localization?: unknown }>): Promise<string | null> {
  if (!isPostgres()) return null;
  const locale = await effectiveLocale(collection);
  if (!locale) return null;
  const installed = await icuCollations();
  return [`${locale.code}-x-icu`, `${locale.code.split("-")[0]}-x-icu`].find((name) => installed.has(name)) ?? null;
}

const isText = (field: Field) => fieldStorage(field).sql === "text";

/** CASE t."locale" WHEN $1 THEN 0 WHEN $2 THEN 1 … END: nearest in the chain first. */
const chainOrder = (alias: string, chain: string[]) =>
  sql`CASE ${sql.ref(`${alias}.locale`)} ${sql.join(chain.map((code, index) => sql`WHEN ${code} THEN ${sql.lit(index)}`), sql` `)} END`;

const empty = (alias: string, field: Field) => (isText(field)
  ? sql`(${sql.ref(`${alias}.${field.name}`)} IS NULL OR ${sql.ref(`${alias}.${field.name}`)} = '')`
  : sql`${sql.ref(`${alias}.${field.name}`)} IS NULL`);

/**
 * A derived table that reads like `rec_<slug>`: the same column names, plus `locale`.
 * The rule compiler, filters, sorts and evaluator work on it unchanged.
 *
 * The effective translation is the first language in the chain with a published row,
 * otherwise the first with any row. Its status and values are the record's for this
 * read, so a visitor never sees a draft translation, and `status = "published"` means
 * "published in the language read". `fieldFallback` fills empty fields only into a
 * published translation, and only from published ones.
 */
export function localizedSource(collection: LocalizableCollection, locale: CollectionLocale): RawBuilder<unknown> {
  const records = tableName(collection.slug);
  const translations = localeTableName(collection.slug);
  const shared = sharedFields(collection).map((field) => sql`r.${sql.id(field.name)}`);
  const config = localizationOf(collection)!;
  const fill = config.fieldFallback && locale.chain.length > 1 && locale.missing === "absent";

  const localized = localizedFields(collection).map((field) => {
    if (!fill) return sql`c.${sql.id(field.name)}`;
    const nearest = sql`(SELECT t.${sql.id(field.name)} FROM ${sql.table(translations)} t WHERE t."recordId" = r."id" AND t."locale" IN (${sql.join(locale.chain)}) AND t."status" = 'published' AND NOT ${empty("t", field)} ORDER BY ${chainOrder("t", locale.chain)} LIMIT 1)`;
    return sql`CASE WHEN c."status" = 'published' AND ${empty("c", field)} THEN ${nearest} ELSE c.${sql.id(field.name)} END AS ${sql.id(field.name)}`;
  });

  if (locale.missing === "empty") {
    const columns = [
      sql`r."id"`, sql`r."createdAt"`, sql`r."createdById"`, ...rawScopeColumn(records, "r"), ...shared,
      sql`COALESCE(c."locale", ${locale.code}) AS "locale"`,
      sql`COALESCE(c."status", 'draft') AS "status"`,
      sql`c."publishedAt" AS "publishedAt"`,
      sql`COALESCE(c."updatedAt", r."updatedAt") AS "updatedAt"`,
      sql`c."source" AS "_source"`,
      sql`CASE WHEN c."recordId" IS NULL THEN 0 ELSE 1 END AS "_translated"`,
      ...localized,
    ];
    return sql`(SELECT ${sql.join(columns)} FROM ${sql.table(records)} r LEFT JOIN ${sql.table(translations)} c ON c."recordId" = r."id" AND c."locale" = ${locale.code} WHERE 1 = 1${rawScopeCondition(records, "r")})`;
  }

  const pick = sql`(SELECT t."locale" FROM ${sql.table(translations)} t WHERE t."recordId" = r."id" AND t."locale" IN (${sql.join(locale.chain)}) ORDER BY CASE WHEN t."status" = 'published' THEN 0 ELSE 1 END, ${chainOrder("t", locale.chain)} LIMIT 1)`;
  const columns = [
    sql`r."id"`, sql`r."createdAt"`, sql`r."createdById"`, ...rawScopeColumn(records, "r"), ...shared,
    sql`c."locale"`, sql`c."status"`, sql`c."publishedAt"`, sql`c."updatedAt"`,
    sql`c."source" AS "_source"`,
    sql`1 AS "_translated"`,
    ...localized,
  ];
  return sql`(SELECT ${sql.join(columns)} FROM ${sql.table(records)} r JOIN ${sql.table(translations)} c ON c."recordId" = r."id" AND c."locale" = ${pick} WHERE 1 = 1${rawScopeCondition(records, "r")})`;
}

/**
 * What a query on this collection reads from: the record table, or for a localized
 * collection the derived table above, aliased to the record table's name. Typed as a
 * table name because Kysely accepts either and the column names are the same.
 */
export async function readSource(collection: WithLocale<LocalizableCollection>): Promise<string> {
  // Every read of a collection's records goes through here, so this is where a cached site
  // read learns what it depends on (core/site/cache.ts). A write registers nothing.
  trackCollectionRead(collection.id);
  const locale = await effectiveLocale(collection);
  if (!locale) return tableName(collection.slug);
  return localizedSource(collection, locale).as(tableName(collection.slug)) as unknown as string;
}

/** Splits submitted values into the record's shared columns and one language's columns. */
export function splitValues(collection: LocalizableCollection, values: Record<string, unknown>) {
  const localized = new Set(localizedFields(collection).map((field) => field.name));
  const shared: Record<string, unknown> = {};
  const translated: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) (localized.has(name) ? translated : shared)[name] = value;
  return { shared, translated };
}

/** Writes one language's row, creating it when the record has no translation in that language yet. */
export async function upsertTranslation(trx: Trx, collection: LocalizableCollection, recordId: number, code: string, row: Record<string, unknown>) {
  const table = localeTableName(collection.slug);
  const exists = await trx.selectFrom(table).select("recordId").where("recordId", "=", recordId).where("locale", "=", code).executeTakeFirst();
  if (exists) {
    if (Object.keys(row).length) await trx.updateTable(table).set(row).where("recordId", "=", recordId).where("locale", "=", code).execute();
    return false;
  }
  await trx.insertInto(table).values({ ...row, recordId, locale: code }).execute();
  return true;
}

/** Keeps the record table's status and publishedAt equal to the default language's, after a write to it. */
export async function mirrorStatus(trx: Trx, collection: LocalizableCollection, recordId: number, status: string, publishedAt: unknown) {
  await trx.updateTable(tableName(collection.slug)).set({ status, publishedAt }).where("id", "=", recordId).execute();
}

/** The languages a record has a translation in, with each one's status. */
export async function translationsOf(collection: LocalizableCollection, recordId: number, db: Trx | typeof recordsDb = recordsDb) {
  const rows = await db.selectFrom(localeTableName(collection.slug)).select(["locale", "status", "publishedAt", "updatedAt", "source"]).where("recordId", "=", recordId).execute();
  return rows as Array<{ locale: string; status: string; publishedAt: string | null; updatedAt: string; source: string | null }>;
}

/** Every translation status for these records, for the grid. */
export async function translationStatuses(collection: LocalizableCollection, recordIds: number[]) {
  if (!recordIds.length || !localizationOf(collection)) return new Map<number, Array<{ locale: string; status: string; source: string | null; updatedAt: string }>>();
  const rows = await recordsDb.selectFrom(localeTableName(collection.slug)).select(["recordId", "locale", "status", "source", "updatedAt"]).where("recordId", "in", recordIds).execute();
  const result = new Map<number, Array<{ locale: string; status: string; source: string | null; updatedAt: string }>>();
  for (const row of rows) {
    const list = result.get(row.recordId as number) ?? [];
    list.push({ locale: row.locale as string, status: row.status as string, source: row.source as string | null, updatedAt: row.updatedAt as string });
    result.set(row.recordId as number, list);
  }
  return result;
}

const localizedCollections = async () => (await prisma.collection.findMany({ where: { type: { not: "view" } }, select: { id: true, slug: true, localization: true } })).filter((collection) => localizationOf(collection));

/** After the default language changes: each record table's status follows the new default. */
export async function refreshDefaultMirrors(code: string) {
  for (const collection of await localizedCollections()) {
    await sql.raw(ddl.mirrorDefaultStatus(tableName(collection.slug), localeTableName(collection.slug), code)).execute(recordsDb);
  }
}

/** Deletes every translation in a language, with its history, schedules, links and search entries. Returns how many rows went. */
export async function purgeLocaleContent(code: string) {
  let removed = 0;
  await recordsDb.transaction().execute(async (trx) => {
    for (const collection of await localizedCollections()) {
      const result = await trx.deleteFrom(localeTableName(collection.slug)).where("locale", "=", code).executeTakeFirst();
      removed += Number(result.numDeletedRows ?? 0);
      await trx.deleteFrom("RecordRef").where("sourceCollectionId", "=", collection.id).where("locale", "=", code).execute();
      await trx.deleteFrom("FileRef").where("sourceCollectionId", "=", collection.id).where("locale", "=", code).execute();
      await trx.deleteFrom("Revision").where("collectionId", "=", collection.id).where("locale", "=", code).execute();
      await trx.deleteFrom("ScheduledAction").where("collectionId", "=", collection.id).where("locale", "=", code).execute();
    }
    const { removeLocaleSearchEntries } = await import("../search");
    await removeLocaleSearchEntries(trx, code);
  });
  return removed;
}
