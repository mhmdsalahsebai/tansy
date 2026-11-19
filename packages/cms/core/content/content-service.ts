import "server-only";
import { isDeepStrictEqual } from "node:util";
import { sql, type RawBuilder, type SqlBool, type Transaction } from "kysely";
import { passesResidual, type RuleColumns, type RuleFilter } from "../authz/rules/sql";
import { ruleColumnNames } from "../authz/rules/evaluate";
import { loadBlockCatalog, upgradeRows, validateRecordValues } from "../blocks/service";
import { collectionResolver, declaredLinks, streamFiles, streamRefs, type Block, type BlockCatalog } from "../blocks/stream";
import { decodeColumn, type ColumnType } from "../fields/define";
import { hasHooks, runBeforeHooks, type HookActor } from "../extend/hooks";
import { fieldStorage, hasValueRefs, referencedCollection, valueRefs } from "../fields/registry";
import { syncFileRefs, type FileActor } from "../files/refs";
import { badRequest, HttpError, notFound } from "../http/errors";
import { emitRecordEvent } from "../realtime/hub";
import { columnFromUniqueError, fieldIdFromUniqueIndex, isSingletonViolation } from "../schema/ddl";
import { tableName } from "../schema/names";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";
import { requireCollection, type CollectionWithFields } from "./access";
import { chunks } from "./chunks";
import { recordsDb } from "./db";
import { SCOPE_COLUMN } from "../scope/context";
import { scopedCollectionIds } from "../scope/registry";
import { assertRecordRoom } from "../scope/limits";
import { forKeyShare, forUpdate } from "./locks";
import { conditionNotMet, recordChanged, sameMoment, type RecordRow } from "./records";
import { enqueueAfterHooks } from "../extend/hook-deliveries";
import { isIndexed, searchText, type SearchCatalog } from "../search/extract";
import { clearCollectionSearch, queueSearch, removeSearchEntry, searchAdapter, writeSearchEntry } from "../search";
import { byFieldId, ensureBaseline, snapshotRecord } from "./revision-store";
import { snapshotOf, trashLabel, trashSettings, writeTrashEntry, type TrashSnapshot, type TrashedInboundLink, type TrashedTranslation, type TrashedValues } from "./trash";
import type { TrashedRecord } from "../../generated/client-sqlite";
import { SYSTEM_COLUMNS } from "./rule-lookup";
import { isLocalizedCollection, isLocalizedField, localizedFields, refLocale, type CollectionLocale } from "../i18n/context";
import { mirrorStatus, readSource, sortCollation, splitValues, upsertTranslation } from "../i18n/storage";
import { defaultLocale } from "../i18n/locales";
import { localeTableName } from "../schema/names";
import { removeLocaleSearchEntry, writeLocaleSearchEntry } from "../search";
import { assertLocaleWritable } from "../i18n/permissions";
import { assertMayPublish } from "./workflow";
import { alignStream, isSyncedStream } from "../i18n/synced";

export type Trx = Transaction<Record<string, Record<string, unknown>>>;

/** The record table, for writes. Reads go through `source`, which for a localized collection joins one language. */
const table = (collection: CollectionWithFields) => tableName(collection.slug);
const source = (collection: CollectionWithFields) => readSource(collection);
const storageOf = fieldStorage;

const invalid = (path: string, message: string) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path, message }]);

/** The SQLite driver can't bind booleans or objects. Postgres takes real booleans, and JSON and dates as text. */
export function encode(kind: ColumnType, value: unknown) {
  if (value === null) return null;
  if (kind === "json") return JSON.stringify(value);
  if (kind === "boolean") return isPostgres() ? Boolean(value) : value ? 1 : 0;
  // Always UTC, so the stored text sorts in time order.
  if (kind === "datetime") return new Date(value as string).toISOString();
  return value;
}

/** `part` picks a localized collection's shared columns, on the record table, or its localized ones, on a translation row. */
function toColumns(collection: CollectionWithFields, values: Record<string, unknown>, part: "all" | "shared" | "localized" = "all") {
  const columns: Record<string, unknown> = {};
  for (const field of collection.fields) {
    if (part !== "all" && isLocalizedField(collection, field) !== (part === "localized")) continue;
    if (field.name in values) columns[field.name] = encode(storageOf(field).sql, values[field.name]);
  }
  return columns;
}

function toRow(collection: CollectionWithFields, row: Record<string, unknown>) {
  const decoded = { ...row };
  for (const field of collection.fields) decoded[field.name] = decodeColumn(storageOf(field).sql, row[field.name]);
  // Kept for decideRecord, and out of anything that copies or serializes the record.
  if (SCOPE_COLUMN in decoded) {
    const scope = decoded[SCOPE_COLUMN];
    delete decoded[SCOPE_COLUMN];
    Object.defineProperty(decoded, SCOPE_COLUMN, { value: scope, enumerable: false });
  }
  return decoded as RecordRow;
}

const toRows = (collection: CollectionWithFields, rows: Array<Record<string, unknown>>) => upgradeRows(collection.fields, rows.map((row) => toRow(collection, row)));
export const toRecord = async (collection: CollectionWithFields, row: Record<string, unknown>) => (await toRows(collection, [row]))[0];

/** Turns unique violations into errors on the field concerned. */
export function fieldError(collection: CollectionWithFields, error: unknown): unknown {
  const { code, message, constraint } = error as { code?: string; message?: string; constraint?: string };
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505") {
    if (isSingletonViolation({ message, constraint })) return new HttpError(409, "SINGLETON_EXISTS", "This singleton already has its record. Update that one instead.");
    const fieldId = fieldIdFromUniqueIndex(constraint);
    const field = collection.fields.find((f) => (code === "23505" ? f.id === fieldId : f.name === columnFromUniqueError(message ?? "")));
    return field ? invalid(field.name, "This value is already in use.") : error;
  }
  // Postgres enforces limits SQLite doesn't: value ranges, and the size of an indexed value.
  if (code === "22003" || code === "22007" || code === "22008") return invalid("", "A value is outside the range the database can store.");
  if (code === "54000") return invalid("", "A value in a unique field is too long to index.");
  if (code === "40P01") return new HttpError(409, "CONFLICT", "Another save got in the way. Try again.");
  return error;
}

/**
 * A record every scope reads can't link to one only some can (decision 38 in
 * internal/MULTI_TENANT_PLAN.md): the link would name a record most readers can't see.
 */
const crossesScope = (collection: CollectionWithFields, target: number) => !collection.scoped && scopedCollectionIds().has(target);
const SHARED_TO_SCOPED = "A record shared by every scope can't link to a record in a scoped collection.";

/** Views have no rows of their own to hold. */
function existingTargets(trx: Trx, target: { slug: string; type: string }, ids: number[]) {
  const query = trx.selectFrom(tableName(target.slug)).select("id").where("id", "in", ids);
  return (target.type === "view" ? query : forKeyShare(query)).execute();
}

/**
 * Runs after the write, and holds each target until commit, so it can't vanish
 * in between. These links aren't foreign keys because SQLite can't drop a column
 * that has one, and fields must stay removable.
 */
async function assertReferencesExist(trx: Trx, collection: CollectionWithFields, values: Record<string, unknown>) {
  const links = collection.fields.flatMap((field) => {
    const target = storageOf(field).references;
    return target && values[field.name] !== null && field.name in values ? [{ field, target }] : [];
  });
  if (!links.length) return;
  const targets = await prisma.collection.findMany({ where: { id: { in: links.map((link) => link.target) } }, select: { id: true, slug: true, type: true } });
  const byId = new Map(targets.map((target) => [target.id, target]));
  for (const { field, target } of links) {
    if (crossesScope(collection, target)) throw invalid(field.name, SHARED_TO_SCOPED);
    const owner = byId.get(target);
    const ids = [values[field.name]].flat() as number[];
    if (!ids.length) continue;
    const found = owner ? await existingTargets(trx, owner, ids) : [];
    if (found.length !== ids.length) throw invalid(field.name, "The referenced record does not exist.");
  }
}

/**
 * Keeps RecordRef in step with the stream fields and `refs` fields just written.
 * Runs inside the write transaction for the same reason as assertReferencesExist.
 * Rows for blocks the current schema can't read are kept, since those blocks were
 * kept as they are. A link on the record itself has an empty block id.
 */
async function syncBlockRefs(trx: Trx, collection: CollectionWithFields, recordId: number, values: Record<string, unknown>, locale?: string) {
  const linking = collection.fields.filter((field) => field.name in values && (field.type === "stream" || hasValueRefs(field.type)));
  if (!linking.length) return;
  const catalog = linking.some((field) => field.type === "stream") ? await loadBlockCatalog() : new Map();
  const targets = await prisma.collection.findMany({ select: { id: true, slug: true, type: true } });
  const byId = new Map(targets.map((target) => [target.id, target]));
  const resolve = collectionResolver(targets);
  for (const field of linking) {
    const { refs, opaque } = field.type === "stream"
      ? streamRefs((values[field.name] ?? []) as Block[], catalog, resolve)
      : { refs: declaredLinks(field, values[field.name], resolve).flatMap(({ targetCollectionId, targetRecordIds }) => targetRecordIds.map((targetRecordId) => ({ blockId: "", targetCollectionId, targetRecordId }))), opaque: new Set<string>() };
    const language = refLocale(collection, field, locale);
    let stale = trx.deleteFrom("RecordRef").where("fieldId", "=", field.id).where("sourceRecordId", "=", recordId).where("locale", "=", language);
    for (const part of chunks([...opaque])) stale = stale.where("blockId", "not in", part);
    await stale.execute();

    for (const target of new Set(refs.map((ref) => ref.targetCollectionId))) {
      if (crossesScope(collection, target)) throw invalid(field.name, SHARED_TO_SCOPED);
      const ids = [...new Set(refs.filter((ref) => ref.targetCollectionId === target).map((ref) => ref.targetRecordId))];
      const owner = byId.get(target);
      let found = 0;
      for (const part of chunks(ids)) found += owner ? (await existingTargets(trx, owner, part)).length : 0;
      if (found !== ids.length) throw invalid(field.name, field.type === "stream" ? "A block references a record that does not exist." : "The referenced record does not exist.");
    }
    for (const part of chunks(refs)) {
      await trx.insertInto("RecordRef").values(part.map((ref) => ({ ...ref, sourceCollectionId: collection.id, sourceRecordId: recordId, fieldId: field.id, locale: language }))).execute();
    }
  }
}

/** A page of records in id order, as stored, for rewriting in place. A localized collection's are read in the collection's language. */
export async function recordsAfter(trx: Trx, collection: CollectionWithFields, after: number, limit: number) {
  const rows = await trx.selectFrom(await source(collection)).selectAll().where("id", ">", after).orderBy("id").limit(limit).execute();
  return rows.map((row) => toRow(collection, row));
}

function linksIn(field: CollectionWithFields["fields"][number], value: unknown, catalog: BlockCatalog) {
  if (field.type !== "stream") return valueRefs(field, value);
  const blocks = (Array.isArray(value) ? value : []) as Block[];
  return [streamRefs(blocks, catalog).refs, streamFiles(blocks, catalog).files.map(({ blockId, fileIds }) => [blockId, fileIds])];
}

/**
 * Stores values a field type's upgrade produced. Not an edit, so it makes no
 * revision and fires no hooks or events, and the links are rewritten only if the
 * upgrade moved them, so a link left dangling long ago can't stop it.
 */
export async function rewriteRecordValues(trx: Trx, collection: CollectionWithFields, row: RecordRow, values: Record<string, unknown>, catalog: BlockCatalog) {
  const locale = typeof row.locale === "string" ? row.locale : undefined;
  const shared = toColumns(collection, values, isLocalizedCollection(collection) ? "shared" : "all");
  if (Object.keys(shared).length) await trx.updateTable(table(collection)).set(shared).where("id", "=", row.id).execute();
  if (locale && isLocalizedCollection(collection)) {
    const translated = toColumns(collection, values, "localized");
    if (Object.keys(translated).length) await trx.updateTable(localeTableName(collection.slug)).set(translated).where("recordId", "=", row.id).where("locale", "=", locale).execute();
  }
  const moved = collection.fields.filter((field) => field.name in values && !isDeepStrictEqual(linksIn(field, row[field.name], catalog), linksIn(field, values[field.name], catalog)));
  if (!moved.length) return;
  const changed = Object.fromEntries(moved.map((field) => [field.name, values[field.name]]));
  await syncBlockRefs(trx, collection, row.id, changed, locale);
  await syncFileRefs(trx, collection, row.id, changed, { userId: null, canUseAny: true }, locale);
}

/** Every column a rule can read, with how it is stored. */
export function recordColumns(collection: CollectionWithFields): RuleColumns {
  return new Map<string, ColumnType>([
    ...SYSTEM_COLUMNS,
    // The language the record is read in, for rules such as `locale = "fr"`.
    ...(isLocalizedCollection(collection) ? [["locale", "text"] as [string, ColumnType]] : []),
    ...collection.fields.map((field): [string, ColumnType] => [field.name, storageOf(field).sql]),
  ]);
}

export interface SortTerm {
  column: string;
  direction: "asc" | "desc";
}

const DEFAULT_SORT: SortTerm[] = [{ column: "updatedAt", direction: "desc" }];

interface PageOptions {
  page: number;
  perPage: number;
  /** Column names, which the caller must already have checked against the collection. */
  sort?: SortTerm[];
  skipTotal?: boolean;
}

/** SQLite sorts NULL lowest and Postgres highest, and a client shouldn't see a difference. */
function orderTerm({ column, direction }: SortTerm, collation: string | null) {
  const value = collation ? sql`${sql.ref(column)} COLLATE ${sql.id(collation)}` : sql.ref(column);
  return isPostgres()
    ? sql`${value} ${sql.raw(direction === "asc" ? "ASC NULLS FIRST" : "DESC NULLS LAST")}`
    : sql`${value} ${sql.raw(direction === "asc" ? "ASC" : "DESC")}`;
}

/** Text in a localized collection sorts in the language read, where the database knows it. */
async function ordering(collection: CollectionWithFields, terms: SortTerm[]) {
  const collation = await sortCollation(collection);
  const text = new Set(collation ? collection.fields.filter((field) => storageOf(field).sql === "text").map((field) => field.name) : []);
  return [...terms, ...(terms.some((term) => term.column === "id") ? [] : [{ column: "id", direction: "desc" as const }])]
    .map((term) => orderTerm(term, text.has(term.column) ? collation : null));
}

/** Past this, a condition that SQL can't check is refused rather than left to run. */
const MAX_SCANNED_ROWS = 100_000;
const SCAN_BATCH = 1000;

/**
 * For rules and filters with conditions only the evaluator can check. SQL narrows
 * the rows and sorts them, then each is checked here. Only the columns those
 * conditions read are fetched, until the page itself is known.
 */
async function scanPage(collection: CollectionWithFields, filter: RuleFilter, terms: SortTerm[], { page, perPage, skipTotal }: PageOptions) {
  const needed = [...new Set(["id", ...filter.residual.flatMap(({ node, columns }) => ruleColumnNames(node).filter((name) => columns.has(name)))])];
  const first = (page - 1) * perPage;
  const ids: number[] = [];
  let matched = 0;
  const from = await source(collection);
  const order = await ordering(collection, terms);
  await recordsDb.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    for (let offset = 0; ; offset += SCAN_BATCH) {
      if (offset >= MAX_SCANNED_ROWS) throw new HttpError(400, "FILTER_TOO_BROAD", "This filter has to check too many records. Narrow it with exact matches.");
      const rows = await trx.selectFrom(from).where(filter.where).select(needed).orderBy(order).limit(SCAN_BATCH).offset(offset).execute();
      for (const row of rows) {
        if (!passesResidual(filter, row)) continue;
        if (matched >= first && ids.length < perPage) ids.push(row.id as number);
        matched++;
      }
      if (rows.length < SCAN_BATCH || (skipTotal && ids.length === perPage)) return;
    }
  });
  const found = new Map((await findRecordsById(collection, ids)).map((row) => [row.id, row]));
  return { totalItems: skipTotal ? -1 : matched, items: ids.flatMap((id) => found.get(id) ?? []) };
}

/** `totalItems` is -1 with skipTotal. An id tie-break keeps pages stable when sort values repeat. */
export async function listContentPage(collection: CollectionWithFields, filter: RuleFilter, options: PageOptions) {
  const { page, perPage, sort, skipTotal } = options;
  const terms = sort?.length ? sort : DEFAULT_SORT;
  if (filter.residual.length) return scanPage(collection, filter, terms, options);
  const matching = recordsDb.selectFrom(await source(collection)).where(filter.where);
  const totalItems = skipTotal ? -1 : Number((await matching.select(sql<number>`count(*)`.as("total")).executeTakeFirstOrThrow()).total);
  const rows = await matching.selectAll().orderBy(await ordering(collection, terms)).limit(perPage).offset((page - 1) * perPage).execute();
  return { totalItems, items: await toRows(collection, rows) };
}

/**
 * The records of a collection, one row past `limit` so the caller can tell it was cut short.
 * For resolving a relation path in a filter, which has to answer against the target collection.
 * Built through Kysely, so row scopes apply as they do to any read.
 *
 * `narrowing` is a condition that only ever excludes rows the caller would have discarded
 * anyway (`narrowingWhere`), so it decides how many rows are read and never which answer comes
 * out: whatever comes back is still judged in full by the caller.
 */
export async function scanRecords(collection: CollectionWithFields, limit: number, narrowing?: RawBuilder<SqlBool>) {
  const query = recordsDb.selectFrom(await source(collection)).selectAll().limit(limit + 1);
  const rows = await (narrowing ? query.where(narrowing) : query).execute();
  return toRows(collection, rows);
}

/** Whether a JSON array column holds any of these ids. */
export function listContains(column: string, ids: number[]) {
  if (!isPostgres()) return sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${sql.ref(column)}) WHERE value IN (${sql.join(ids)}))`;
  return sql<SqlBool>`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE jsonb_typeof(${sql.ref(column)}) WHEN 'array' THEN ${sql.ref(column)} ELSE '[]'::jsonb END) AS item(value) WHERE item.value IN (${sql.join(ids.map((id) => sql`to_jsonb(${id}::int)`))}))`;
}

/** Ids of the records someone created, the most recently updated first, up to `limit`. */
export async function ownedRecordIds(collection: CollectionWithFields, userId: string, limit: number) {
  const rows = await recordsDb.selectFrom(await source(collection)).select("id").where("createdById", "=", userId).orderBy("updatedAt", "desc").limit(limit).execute();
  return rows.map((row) => row.id as number);
}

export async function findRecordsById(collection: CollectionWithFields, ids: number[]) {
  const found: RecordRow[] = [];
  const from = await source(collection);
  for (const part of chunks(ids)) {
    const rows = await recordsDb.selectFrom(from).selectAll().where("id", "in", part).execute();
    found.push(...(await toRows(collection, rows)));
  }
  return found;
}

/** Records whose reference column points at any of the ids, up to `limit` in total. */
export async function findRecordsReferencing(collection: CollectionWithFields, column: string, multiple: boolean, ids: number[], limit: number) {
  const found: RecordRow[] = [];
  const from = await source(collection);
  for (const part of chunks(ids)) {
    if (found.length >= limit) break;
    const matches = multiple
      ? listContains(column, part)
      : sql<SqlBool>`${sql.ref(column)} IN (${sql.join(part)})`;
    const rows = await recordsDb.selectFrom(from).selectAll().where(matches).orderBy("id", "desc").limit(limit - found.length).execute();
    found.push(...(await toRows(collection, rows)));
  }
  return found;
}

export async function requireContent(collection: CollectionWithFields, id: number) {
  const row = await recordsDb.selectFrom(await source(collection)).selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Record");
  return toRecord(collection, row);
}

/** The record at an address. The columns come from a collection's checked URL pattern. Whether the caller may see it is still to be decided. */
export async function findRecordAt(collection: CollectionWithFields, match: ReadonlyMap<string, string | number>) {
  let query = recordsDb.selectFrom(await source(collection)).selectAll();
  for (const [column, value] of match) query = query.where(column, "=", value);
  const row = await query.limit(1).executeTakeFirst();
  return row ? toRecord(collection, row) : undefined;
}

export async function hasRecords(slug: string) {
  return Boolean(await recordsDb.selectFrom(tableName(slug)).select("id").limit(1).executeTakeFirst());
}

const READ_ONLY = () => new HttpError(405, "VIEW_READ_ONLY", "View collections are read-only.");

export function assertWritable(collection: Pick<CollectionWithFields, "type">) {
  if (collection.type === "view") throw READ_ONLY();
}

/** Other content can rely on a singleton always being there once made. Unpublishing is how to take it down. */
function assertDeletable(collection: Pick<CollectionWithFields, "type">) {
  if (collection.type === "singleton") throw new HttpError(409, "SINGLETON_REQUIRED", "A singleton's record can't be deleted. Unpublish it instead.");
}

/** Holds the row until commit, so what's checked against it stays true for the write. */
export async function requireContentIn(trx: Trx, collection: CollectionWithFields, id: number) {
  if (isLocalizedCollection(collection)) {
    // Locks the record's own row. A derived table can't be locked directly.
    if (!(await forUpdate(trx.selectFrom(table(collection)).select("id").where("id", "=", id)).executeTakeFirst())) throw notFound("Record");
    const row = await trx.selectFrom(await source(collection)).selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw notFound("Record");
    return toRecord(collection, row);
  }
  const row = await forUpdate(trx.selectFrom(table(collection)).selectAll().where("id", "=", id)).executeTakeFirst();
  if (!row) throw notFound("Record");
  return toRecord(collection, row);
}

/** The language a write to a localized collection goes to: the one its caller chose, or the default. */
async function writeTarget(collection: CollectionWithFields) {
  return collection.locale?.code ?? defaultLocale();
}

/** The record as one language holds it, with empty localized values if it has no translation there yet. */
async function readWritten(trx: Trx, collection: CollectionWithFields, id: number, code: string) {
  const locale: CollectionLocale = { code, chain: [code], missing: "empty" };
  const row = await trx.selectFrom(await readSource({ ...collection, locale })).selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Record");
  return row;
}

const translationIssue = (path: string) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path, message: "This field is required." }]);

/** A new translation has to fill in the localized fields that are required, as a new record has to fill in all of them. */
function assertTranslationComplete(collection: CollectionWithFields, values: Record<string, unknown>, existing: Record<string, unknown>) {
  for (const field of localizedFields(collection)) {
    const value = field.name in values ? values[field.name] : existing[field.name];
    if ((field.config as { required?: boolean } | null)?.required && (value === null || value === undefined || value === "")) throw translationIssue(field.name);
  }
}

/** A stable hash of each source value, saved with a translation so later edits to the source show it as outdated. */
async function sourceHashes(trx: Trx, collection: CollectionWithFields, recordId: number, code: string) {
  const sourceLocale = await defaultLocale();
  if (sourceLocale === code) return null;
  const row = await trx.selectFrom(localeTableName(collection.slug)).selectAll().where("recordId", "=", recordId).where("locale", "=", sourceLocale).executeTakeFirst();
  if (!row) return null;
  const decoded = toRow(collection, row);
  const { hashValue } = await import("../i18n/outdated");
  return JSON.stringify({ locale: sourceLocale, hashes: Object.fromEntries(localizedFields(collection).map((field) => [field.id, hashValue(decoded[field.name] ?? null)])) });
}

async function indexTranslations(trx: Trx, collection: CollectionWithFields, recordId: number, locales: string[]) {
  if (!collection.fields.some(isIndexed)) return;
  if (searchAdapter()) {
    for (const code of locales) await queueSearch(trx, collection.id, recordId, code);
    return;
  }
  for (const code of locales) {
    const row = await trx.selectFrom(await readSource({ ...collection, locale: { code, chain: [code], missing: "absent" } })).selectAll().where("id", "=", recordId).executeTakeFirst();
    if (!row) {
      await removeLocaleSearchEntry(trx, collection.id, recordId, code);
      continue;
    }
    await writeLocaleSearchEntry(trx, collection.id, recordId, code, await recordSearchText(collection, toRow(collection, row)));
  }
}

const touchesShared = (collection: CollectionWithFields, values: Record<string, unknown>) => Object.keys(splitValues(collection, values).shared).length > 0;

/** The synced streams among these values. */
const syncedIn = (collection: CollectionWithFields, values: Record<string, unknown>) => localizedFields(collection).filter((field) => isSyncedStream(field) && Object.hasOwn(values, field.name));

/**
 * A translation's synced streams, lined up with the default language's blocks as stored: its
 * text is kept, and blocks, their order and everything that isn't text come from the default
 * language. Before the default language has a row, the translation's own blocks stand.
 */
async function alignToSource(trx: Trx, collection: CollectionWithFields, recordId: number, code: string, primary: string, values: Record<string, unknown>) {
  const fields = syncedIn(collection, values);
  if (code === primary || !fields.length) return values;
  const row = await trx.selectFrom(localeTableName(collection.slug)).selectAll().where("recordId", "=", recordId).where("locale", "=", primary).executeTakeFirst();
  if (!row) return values;
  const source = toRow(collection, row);
  const catalog = await loadBlockCatalog();
  return { ...values, ...Object.fromEntries(fields.map((field) => [field.name, alignStream(source[field.name] ?? null, values[field.name], catalog)])) };
}

/**
 * Lines every record's translations up with the default language, for streams just turned
 * synced. A record at a time, each in its own transaction, so a large collection doesn't hold
 * one long lock. Repeating it changes nothing.
 */
export async function realignSyncedStreams(collectionId: number, names: string[]) {
  const collection = await requireCollection(collectionId) as CollectionWithFields;
  if (!isLocalizedCollection(collection)) return;
  const fields = localizedFields(collection).filter((field) => isSyncedStream(field) && names.includes(field.name));
  if (!fields.length) return;
  const primary = await defaultLocale();
  const system: FileActor = { userId: null, canUseAny: true };
  let after = 0;
  for (;;) {
    const page = await recordsDb.selectFrom(localeTableName(collection.slug)).selectAll().where("locale", "=", primary).where("recordId", ">", after).orderBy("recordId").limit(REALIGN_BATCH).execute();
    for (const raw of page) {
      const row = toRow(collection, raw);
      const values = Object.fromEntries(fields.map((field) => [field.name, row[field.name] ?? null]));
      await recordsDb.transaction().execute(async (trx) => {
        const changed = await realignTranslations(trx, collection, raw.recordId as number, primary, values, system);
        if (changed.length) await indexTranslations(trx, collection, raw.recordId as number, changed);
      });
    }
    if (page.length < REALIGN_BATCH) return;
    after = page.at(-1)!.recordId as number;
  }
}
const REALIGN_BATCH = 200;

/**
 * After the default language's synced streams change, every other language follows their
 * blocks: a new block appears in each, untranslated, and a removed or moved one goes or moves
 * there too. Their wording is kept, and their status and history aren't touched. Returns the
 * languages that changed.
 */
async function realignTranslations(trx: Trx, collection: CollectionWithFields, recordId: number, primary: string, values: Record<string, unknown>, actor: FileActor) {
  const fields = syncedIn(collection, values);
  if (!fields.length) return [];
  const catalog = await loadBlockCatalog();
  const others = await trx.selectFrom(localeTableName(collection.slug)).selectAll().where("recordId", "=", recordId).where("locale", "!=", primary).execute();
  const changed: string[] = [];
  for (const raw of others) {
    const current = toRow(collection, raw);
    const aligned = Object.fromEntries(fields.map((field) => [field.name, alignStream(values[field.name] ?? null, current[field.name], catalog)]));
    if (fields.every((field) => isDeepStrictEqual(aligned[field.name], current[field.name] ?? null))) continue;
    const code = raw.locale as string;
    await trx.updateTable(localeTableName(collection.slug)).set(toColumns(collection, aligned, "localized")).where("recordId", "=", recordId).where("locale", "=", code).execute();
    await syncBlockRefs(trx, collection, recordId, aligned, code);
    await syncFileRefs(trx, collection, recordId, aligned, actor, code);
    changed.push(code);
  }
  return changed;
}

async function createLocalizedIn(trx: Trx, collection: CollectionWithFields, status: "draft" | "published" | undefined, values: Record<string, unknown>, createdById: string | null, actor: FileActor) {
  const code = await writeTarget(collection);
  const primary = await defaultLocale();
  assertLocaleWritable(collection, actor, code, touchesShared(collection, values), primary);
  assertTranslationComplete(collection, values, {});
  const next = status ?? "draft";
  const now = new Date().toISOString();
  const publishedAt = next === "published" ? now : null;
  const created = await trx.insertInto(table(collection))
    .values({ ...toColumns(collection, values, "shared"), status: code === primary ? next : "draft", publishedAt: code === primary ? publishedAt : null, createdById })
    .returning("id")
    .executeTakeFirstOrThrow();
  const id = created.id as number;
  await trx.insertInto(localeTableName(collection.slug)).values({ ...toColumns(collection, values, "localized"), recordId: id, locale: code, status: next, publishedAt, createdAt: now, updatedAt: now, updatedById: actor.userId, source: await sourceHashes(trx, collection, id, code) }).execute();
  const row = await readWritten(trx, collection, id, code);
  await assertReferencesExist(trx, collection, values);
  await syncBlockRefs(trx, collection, id, values, code);
  await syncFileRefs(trx, collection, id, values, actor, code);
  await snapshotRecord(trx, collection, toRow(collection, row), createdById, undefined, code);
  await indexTranslations(trx, collection, id, [code]);
  await enqueueAfterHooks(trx, collection, "create", await toRecord(collection, row));
  return row;
}

async function updateLocalizedIn(trx: Trx, collection: CollectionWithFields, item: RecordRow, status: "draft" | "published" | undefined, given: Record<string, unknown>, actor: FileActor, note: string | undefined, guard: WriteGuard) {
  const code = await writeTarget(collection);
  const primary = await defaultLocale();
  const values = await alignToSource(trx, collection, item.id, code, primary, given);
  const shared = touchesShared(collection, values);
  assertLocaleWritable(collection, actor, code, shared, primary);
  if (!(await forUpdate(trx.selectFrom(table(collection)).select("id").where("id", "=", item.id)).executeTakeFirst())) throw notFound("Record");
  const current = toRow(collection, await readWritten(trx, collection, item.id, code));
  if (guard.updatedAt && !sameMoment(current.updatedAt, guard.updatedAt)) throw recordChanged();
  if (guard.match && !recordMatches(collection, current, guard.match)) throw conditionNotMet();
  const isNew = Number(current._translated) === 0;
  if (isNew) assertTranslationComplete(collection, values, current);

  const next = status ?? (current.status as "draft" | "published");
  // A translation is published on its own, so its own status decides.
  assertMayPublish(collection, actor, current.status, next);
  const now = new Date().toISOString();
  const publishedAt = next === "published" ? (current.publishedAt ?? now) : null;
  const sharedColumns = toColumns(collection, values, "shared");
  if (Object.keys(sharedColumns).length || code === primary) {
    await trx.updateTable(table(collection)).set({ ...sharedColumns, updatedAt: now }).where("id", "=", item.id).execute();
  }
  if (code === primary) await mirrorStatus(trx, collection, item.id, next, publishedAt);
  await upsertTranslation(trx, collection, item.id, code, {
    ...toColumns(collection, values, "localized"),
    status: next, publishedAt, updatedAt: now, updatedById: actor.userId,
    ...(isNew ? { createdAt: now } : {}),
    // Saving a translation marks it up to date with its source. Saving the source changes nothing stored on the others.
    ...(code === primary ? {} : { source: await sourceHashes(trx, collection, item.id, code) }),
  });
  const row = await readWritten(trx, collection, item.id, code);
  await assertReferencesExist(trx, collection, values);
  await syncBlockRefs(trx, collection, item.id, values, code);
  await syncFileRefs(trx, collection, item.id, values, actor, code);
  const realigned = code === primary ? await realignTranslations(trx, collection, item.id, primary, values, actor) : [];
  if (!isNew) await ensureBaseline(trx, collection, current, code);
  if (next === "published") await closeReview(trx, collection.id, item.id, code);
  await snapshotRecord(trx, collection, toRow(collection, row), actor.userId, note, code);
  // Shared searchable text appears in every language's entry.
  const others = shared ? (await trx.selectFrom(localeTableName(collection.slug)).select("locale").where("recordId", "=", item.id).execute()).map((entry) => entry.locale as string) : [];
  await indexTranslations(trx, collection, item.id, [...new Set([code, ...others, ...realigned])]);
  await enqueueAfterHooks(trx, collection, "update", await toRecord(collection, row), current);
  return row;
}

/** The write itself, for callers that hold a transaction. Publish the realtime event after it commits. */
export async function createRecordIn(trx: Trx, collection: CollectionWithFields, status: "draft" | "published" | undefined, values: Record<string, unknown>, createdById: string | null, actor: FileActor) {
  assertWritable(collection);
  // A scope value's limit on records (core/scope/limits.ts). Only scoped collections count toward it.
  if (collection.scoped) await assertRecordRoom(trx);
  assertMayPublish(collection, actor, null, status);
  if (isLocalizedCollection(collection)) return createLocalizedIn(trx, collection, status, values, createdById, actor);
  const next = status ?? "draft";
  const created = await trx.insertInto(table(collection))
    .values({ ...toColumns(collection, values), status: next, createdById, publishedAt: next === "published" ? new Date().toISOString() : null })
    .returningAll()
    .executeTakeFirstOrThrow();
  await assertReferencesExist(trx, collection, values);
  await syncBlockRefs(trx, collection, created.id as number, values);
  await syncFileRefs(trx, collection, created.id as number, values, actor);
  await snapshotRecord(trx, collection, toRow(collection, created), createdById);
  await indexRecord(trx, collection, toRow(collection, created));
  await enqueueAfterHooks(trx, collection, "create", await toRecord(collection, created));
  return created;
}

/** The full text an outside engine or the built-in index should hold for this record. */
export async function recordSearchText(collection: CollectionWithFields, row: Record<string, unknown>) {
  const fields = collection.fields.filter(isIndexed);
  if (!fields.length) return "";
  const catalog: SearchCatalog = fields.some((field) => field.type === "stream") ? await loadBlockCatalog() : new Map();
  return searchText(fields, row, catalog);
}

async function indexRecord(trx: Trx, collection: CollectionWithFields, row: Record<string, unknown>) {
  if (isLocalizedCollection(collection)) return indexTranslations(trx, collection, row.id as number, typeof row.locale === "string" ? [row.locale] : []);
  if (!collection.fields.some(isIndexed)) return;
  if (searchAdapter()) return queueSearch(trx, collection.id, row.id as number);
  await writeSearchEntry(trx, collection.id, row.id as number, await recordSearchText(collection, row));
}

const REINDEX_BATCH = 500;

/**
 * After a field's search settings change. Runs in the background, so results catch up shortly after a large
 * collection is edited. With an outside engine, the search queue rebuilds it from `collectionSearchEntries`.
 */
export async function reindexCollection(collection: CollectionWithFields) {
  if (collection.type === "view") return;
  await clearCollectionSearch(collection.id);
  if (searchAdapter()) return;
  for await (const entry of collectionSearchEntries(collection)) {
    await recordsDb.transaction().execute((trx) => entry.locale === undefined
      ? writeSearchEntry(trx, collection.id, entry.recordId, entry.text)
      : writeLocaleSearchEntry(trx, collection.id, entry.recordId, entry.locale, entry.text));
  }
}

/** `scope` is the record's scope value, on a scoped collection, so an outside engine can keep each value's apart. */
export interface SearchEntry { recordId: number; locale?: string; text: string; scope?: string }

const rowScope = (raw: Record<string, unknown> | undefined) => {
  const scope = raw?.[SCOPE_COLUMN];
  return typeof scope === "string" ? { scope } : {};
};

/** One translation, read through the same source a request in that language uses. Null when it doesn't exist. */
async function translationText(collection: CollectionWithFields, recordId: number, code: string) {
  const row = await recordsDb.selectFrom(await readSource({ ...collection, locale: { code, chain: [code], missing: "absent" } })).selectAll().where("id", "=", recordId).executeTakeFirst();
  return row ? recordSearchText(collection, toRow(collection, row)) : null;
}

/** Every record's searchable text, a page at a time, with one entry per translation in a localized collection. Empty text is left out. */
export async function* collectionSearchEntries(collection: CollectionWithFields): AsyncGenerator<SearchEntry> {
  if (collection.type === "view" || !collection.fields.some(isIndexed)) return;
  const localized = isLocalizedCollection(collection);
  for (let after = 0; ;) {
    const rows = await recordsDb.selectFrom(table(collection)).selectAll().where("id", ">", after).orderBy("id").limit(REINDEX_BATCH).execute();
    if (!rows.length) return;
    if (localized) {
      const pairs = await recordsDb.selectFrom(localeTableName(collection.slug)).select(["recordId", "locale"]).where("recordId", "in", rows.map((row) => row.id as number)).orderBy("recordId").execute();
      const byId = new Map(rows.map((row) => [row.id as number, row]));
      for (const { recordId, locale } of pairs) {
        const text = await translationText(collection, recordId as number, locale as string);
        if (text) yield { recordId: recordId as number, locale: locale as string, text, ...rowScope(byId.get(recordId as number)) };
      }
    } else {
      for (const raw of rows) {
        const row = toRow(collection, raw);
        const text = await recordSearchText(collection, row);
        if (text) yield { recordId: row.id, text, ...rowScope(raw) };
      }
    }
    after = rows[rows.length - 1].id as number;
  }
}

/**
 * What an outside engine should hold now for one record: one entry, or one per language for a
 * localized collection. Empty text means its document goes. `locale` limits it to one language;
 * without it, a localized record's every language is read, and null means the record is gone.
 */
export async function recordSearchEntries(collection: CollectionWithFields, recordId: number, locale?: string): Promise<SearchEntry[] | null> {
  if (!isLocalizedCollection(collection)) {
    const raw = await recordsDb.selectFrom(table(collection)).selectAll().where("id", "=", recordId).executeTakeFirst();
    return [{ recordId, text: raw ? await recordSearchText(collection, toRow(collection, raw)) : "", ...rowScope(raw) }];
  }
  const base = await recordsDb.selectFrom(table(collection)).selectAll().where("id", "=", recordId).executeTakeFirst();
  const codes = locale ? [locale] : (await recordsDb.selectFrom(localeTableName(collection.slug)).select("locale").where("recordId", "=", recordId).execute()).map((row) => row.locale as string);
  if (!codes.length) return null;
  return Promise.all(codes.map(async (code) => ({ recordId, locale: code, text: (await translationText(collection, recordId, code)) ?? "", ...rowScope(base) })));
}

/** Values a conditional update compares: plain values only, since JSON and dates have more than one stored form. */
export type MatchValue = string | number | boolean | null;
const MATCHABLE = new Set<ColumnType>(["text", "real", "integer", "boolean"]);

/**
 * What the stored row must still hold for an update to apply. `updatedAt` is the editor's
 * "changed since you opened it" check. `match` is a plugin's conditional update.
 */
export interface WriteGuard { updatedAt?: string; match?: Record<string, MatchValue> }

/** The match as column values. Refuses anything it can't compare exactly. */
function matchColumns(collection: CollectionWithFields, match: Record<string, MatchValue>) {
  const entries = Object.entries(match);
  if (!entries.length) throw badRequest("A condition needs at least one field.");
  return entries.map(([name, value]) => {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw badRequest(`The condition on "${name}" must be text, a number, true, false or null.`);
    if (name === "status") {
      if (value !== "draft" && value !== "published") throw badRequest('The condition on "status" must be "draft" or "published".');
      return [name, value] as const;
    }
    const field = collection.fields.find((candidate) => candidate.name === name);
    const kind = field && storageOf(field).sql;
    if (!kind || !MATCHABLE.has(kind)) throw badRequest(`A condition can't use "${name}". Use a text, number, boolean or select field, or status.`);
    return [name, encode(kind, value)] as const;
  });
}

/** Whether a record as read already matches, so a write that can't apply skips its before-hooks. */
export function recordMatches(collection: CollectionWithFields, item: RecordRow, match: Record<string, MatchValue>) {
  const expected = new Map(matchColumns(collection, match));
  const stored = new Map(matchColumns(collection, Object.fromEntries([...expected.keys()].map((name) => [name, (item[name] ?? null) as MatchValue]))));
  return [...expected].every(([name, value]) => value === stored.get(name));
}

export async function updateRecordIn(trx: Trx, collection: CollectionWithFields, item: RecordRow, status: "draft" | "published" | undefined, values: Record<string, unknown>, actor: FileActor, note?: string, expected?: string | WriteGuard) {
  assertWritable(collection);
  const guard: WriteGuard = typeof expected === "string" ? { updatedAt: expected } : (expected ?? {});
  if (isLocalizedCollection(collection)) return updateLocalizedIn(trx, collection, item, status, values, actor, note, guard);
  const next = status ?? (item.status as "draft" | "published");
  assertMayPublish(collection, actor, item.status, next);
  const now = new Date().toISOString();
  let update = trx.updateTable(table(collection))
    .set({ ...toColumns(collection, values), status: next, publishedAt: next === "published" ? (item.publishedAt ?? now) : null, updatedAt: now })
    .where("id", "=", item.id);
  // In the UPDATE itself, so that of two saves racing from one version, only one can match.
  if (guard.updatedAt) update = update.where("updatedAt", "=", guard.updatedAt);
  for (const [column, value] of guard.match ? matchColumns(collection, guard.match) : []) {
    update = value === null ? update.where(column, "is", null) : update.where(column, "=", value);
  }
  const updated = await update.returningAll().executeTakeFirst();
  if (!updated) {
    const guarded = guard.updatedAt || guard.match;
    const exists = guarded && await trx.selectFrom(table(collection)).select("id").where("id", "=", item.id).executeTakeFirst();
    if (!exists) throw notFound("Record");
    throw guard.updatedAt ? recordChanged() : conditionNotMet();
  }
  await assertReferencesExist(trx, collection, values);
  await syncBlockRefs(trx, collection, item.id, values);
  await syncFileRefs(trx, collection, item.id, values, actor);
  await ensureBaseline(trx, collection, item);
  if (next === "published") await closeReview(trx, collection.id, item.id, "");
  await snapshotRecord(trx, collection, toRow(collection, updated), actor.userId, note);
  await indexRecord(trx, collection, toRow(collection, updated));
  await enqueueAfterHooks(trx, collection, "update", await toRecord(collection, updated), item);
  return updated;
}

type Status = "draft" | "published" | undefined;

/** Published changes have nothing left to review, however they went live. */
async function closeReview(trx: Trx, collectionId: number, recordId: number, locale: string) {
  await trx.deleteFrom("ReviewRequest").where("collectionId", "=", collectionId).where("recordId", "=", recordId).where("locale", "=", locale).execute();
}

/** Hooks can return anything, so changed values are validated again as if newly submitted. */
export async function hookedValues(event: "record.beforeCreate" | "record.beforeUpdate", collection: CollectionWithFields, status: Status, values: Record<string, unknown>, actor: HookActor, existing?: RecordRow) {
  if (!hasHooks(event)) return values;
  const next = await runBeforeHooks(event, collection, { actor, status, values, record: existing });
  return isDeepStrictEqual(next, values) ? values : validateRecordValues(collection.fields, next, existing);
}

export async function createContent(collection: CollectionWithFields, status: Status, submitted: Record<string, unknown>, createdById: string | null, actor: FileActor) {
  assertWritable(collection);
  const values = await hookedValues("record.beforeCreate", collection, status, submitted, actor);
  try {
    const row = await recordsDb.transaction().execute((trx) => createRecordIn(trx, collection, status, values, createdById, actor));
    const record = await toRecord(collection, row);
    emitRecordEvent({ collection, action: "create", row: record });
    return record;
  } catch (error) {
    throw fieldError(collection, error);
  }
}

export async function updateContent(collection: CollectionWithFields, item: RecordRow, status: Status, submitted: Record<string, unknown>, actor: FileActor, note?: string, expected?: string | WriteGuard) {
  assertWritable(collection);
  const values = await hookedValues("record.beforeUpdate", collection, status, submitted, actor, item);
  try {
    const row = await recordsDb.transaction().execute((trx) => updateRecordIn(trx, collection, item, status, values, actor, note, expected));
    const record = await toRecord(collection, row);
    emitRecordEvent({ collection, action: "update", row: record, previous: item });
    return record;
  } catch (error) {
    throw fieldError(collection, error);
  }
}

/** How many cleared inbound links one entry remembers, so a widely linked record's snapshot stays small. */
const TRASH_INBOUND_LIMIT = 1_000;

/** Keeping the record in the trash: its retention, and who deleted it. Null deletes it for good. */
export type TrashIntent = { retentionDays: number; deletedById: string | null } | null;

/**
 * Deletes a record and clears any references to it, in one transaction. With `trash`, what the
 * delete clears is first written to a trash entry in the same transaction, so the record can be
 * put back (core/content/trash.ts). Callers that mean a permanent delete pass null.
 */
export async function deleteRecordIn(trx: Trx, collection: CollectionWithFields, id: number, trash: TrashIntent = null) {
  assertWritable(collection);
  assertDeletable(collection);
  const fields = await prisma.field.findMany({ include: { collection: { select: { slug: true } } } });
  const incoming = fields.filter((field) => referencedCollection(field.type, field.config) === collection.id);
  {
    // A localized record's values live in its translations, so hooks get it as read in its language.
    const before = isLocalizedCollection(collection) ? await trx.selectFrom(await source(collection)).selectAll().where("id", "=", id).executeTakeFirst() : undefined;
    // Read for the trash while it is all still there.
    const translations: TrashedTranslation[] = trash && isLocalizedCollection(collection)
      ? (await trx.selectFrom(localeTableName(collection.slug)).selectAll().where("recordId", "=", id).execute()).map((raw) => ({
        locale: String(raw.locale),
        status: String(raw.status),
        publishedAt: asText(raw.publishedAt),
        createdAt: asText(raw.createdAt) ?? new Date().toISOString(),
        updatedAt: asText(raw.updatedAt) ?? new Date().toISOString(),
        updatedById: (raw.updatedById as string | null) ?? null,
        source: (raw.source as string | null) ?? null,
        values: JSON.parse(JSON.stringify(byFieldId(collection, toRow(collection, raw)))),
      }))
      : [];
    const fileIds = trash
      ? (await trx.selectFrom("FileRef").select("fileId").where("sourceCollectionId", "=", collection.id).where("sourceRecordId", "=", id).execute()).map((row) => String(row.fileId))
      : [];
    const removed = await trx.deleteFrom(table(collection)).where("id", "=", id).returningAll().executeTakeFirst();
    if (!removed) throw notFound("Record");
    const deleted = before ?? removed;
    await trx.deleteFrom("RecordRef").where("sourceCollectionId", "=", collection.id).where("sourceRecordId", "=", id).execute();
    await trx.deleteFrom("FileRef").where("sourceCollectionId", "=", collection.id).where("sourceRecordId", "=", id).execute();
    await trx.deleteFrom("Revision").where("collectionId", "=", collection.id).where("recordId", "=", id).execute();
    await trx.deleteFrom("ScheduledAction").where("collectionId", "=", collection.id).where("recordId", "=", id).execute();
    await trx.deleteFrom("ReviewRequest").where("collectionId", "=", collection.id).where("recordId", "=", id).execute();
    await removeSearchEntry(trx, collection.id, id);
    if (isLocalizedCollection(collection)) {
      await trx.deleteFrom(localeTableName(collection.slug)).where("recordId", "=", id).execute();
      await removeLocaleSearchEntry(trx, collection.id, id);
    }
    // Clearing a link inside stored blocks would rewrite content the author wrote, so it has to be their decision.
    const linked = await trx.selectFrom("RecordRef").select("id").where("targetCollectionId", "=", collection.id).where("targetRecordId", "=", id).limit(1).executeTakeFirst();
    if (linked) throw new HttpError(409, "CONFLICT", "Other records still link to this record from inside their content. Remove those links first.");
    const inbound: TrashedInboundLink[] = [];
    let inboundLimited = false;
    for (const field of incoming) {
      const owner = tableName(field.collection.slug);
      const list = storageOf(field).sql === "json";
      if (trash) {
        if (inbound.length >= TRASH_INBOUND_LIMIT) inboundLimited = true;
        else {
          const owners = await trx.selectFrom(owner).select("id").where(list ? listContains(field.name, [id]) : sql<SqlBool>`${sql.ref(field.name)} = ${id}`).limit(TRASH_INBOUND_LIMIT - inbound.length + 1).execute();
          if (owners.length > TRASH_INBOUND_LIMIT - inbound.length) inboundLimited = true;
          for (const row of owners.slice(0, TRASH_INBOUND_LIMIT - inbound.length)) inbound.push({ collectionId: field.collectionId, recordId: row.id as number, fieldId: field.id, list });
        }
      }
      if (list) {
        const list = sql.ref(field.name);
        if (isPostgres()) {
          const member = sql`to_jsonb(${id}::int)`;
          await sql`UPDATE ${sql.table(owner)} SET ${list} = (SELECT COALESCE(jsonb_agg(item.value ORDER BY item.position), '[]'::jsonb) FROM jsonb_array_elements(${list}) WITH ORDINALITY AS item(value, position) WHERE item.value <> ${member}) WHERE ${list} @> ${member}`.execute(trx);
        } else {
          await sql`UPDATE ${sql.table(owner)} SET ${list} = (SELECT json_group_array(value) FROM json_each(${list}) WHERE value <> ${id}) WHERE EXISTS (SELECT 1 FROM json_each(${list}) WHERE value = ${id})`.execute(trx);
        }
      } else {
        await trx.updateTable(owner).set({ [field.name]: null }).where(field.name, "=", id).execute();
      }
    }
    if (trash) {
      const snapshot: TrashSnapshot = {
        version: 1,
        values: JSON.parse(JSON.stringify(byFieldId(collection, toRow(collection, removed)))),
        createdAt: asText(removed.createdAt) ?? new Date().toISOString(),
        updatedAt: asText(removed.updatedAt) ?? new Date().toISOString(),
        publishedAt: asText(removed.publishedAt),
        createdById: (removed.createdById as string | null) ?? null,
        ...(translations.length ? { translations } : {}),
        ...(inbound.length ? { inbound } : {}),
        ...(inboundLimited ? { inboundLimited } : {}),
      };
      await writeTrashEntry(trx, {
        collection,
        recordId: id,
        label: trashLabel(collection, toRow(collection, deleted)),
        status: String(removed.status),
        snapshot,
        fileIds,
        createdById: (removed.createdById as string | null) ?? null,
        deletedById: trash.deletedById,
        retentionDays: trash.retentionDays,
        scope: typeof removed[SCOPE_COLUMN] === "string" ? (removed[SCOPE_COLUMN] as string) : "",
      });
    }
    await enqueueAfterHooks(trx, collection, "delete", await toRecord(collection, deleted));
    return deleted;
  }
}

/** A stored timestamp as text: SQLite keeps ISO strings, Postgres real timestamps. */
const asText = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

/**
 * Removes one language's translation, with its history, schedules, links and search entry.
 * The record and its other translations stay. Its last translation can't go: delete the record.
 */
export async function deleteTranslation(collection: CollectionWithFields, item: RecordRow, code: string, actor: FileActor) {
  assertWritable(collection);
  if (!isLocalizedCollection(collection)) throw new HttpError(400, "NOT_LOCALIZED", "This collection has one language.");
  const primary = await defaultLocale();
  assertLocaleWritable(collection, actor, code, false, primary);
  const translations = localeTableName(collection.slug);
  await recordsDb.transaction().execute(async (trx) => {
    if (!(await forUpdate(trx.selectFrom(table(collection)).select("id").where("id", "=", item.id)).executeTakeFirst())) throw notFound("Record");
    const rows = await trx.selectFrom(translations).select("locale").where("recordId", "=", item.id).execute();
    if (!rows.some((row) => row.locale === code)) throw notFound("Translation");
    if (rows.length === 1) throw new HttpError(409, "LAST_TRANSLATION", "This is the record's only translation. Delete the record instead.");
    await trx.deleteFrom(translations).where("recordId", "=", item.id).where("locale", "=", code).execute();
    for (const name of ["RecordRef", "FileRef"]) await trx.deleteFrom(name).where("sourceCollectionId", "=", collection.id).where("sourceRecordId", "=", item.id).where("locale", "=", code).execute();
    for (const name of ["Revision", "ScheduledAction"]) await trx.deleteFrom(name).where("collectionId", "=", collection.id).where("recordId", "=", item.id).where("locale", "=", code).execute();
    await removeLocaleSearchEntry(trx, collection.id, item.id, code);
    if (code === primary) await mirrorStatus(trx, collection, item.id, "draft", null);
  });
  emitRecordEvent({ collection, action: "update", row: { ...item, status: "draft" }, previous: item });
}

/**
 * `trash` defaults to what Settings → Security → Trash says, so every way of deleting a record
 * through the API, a plugin or the dashboard is recoverable. Pass null for a permanent delete.
 */
export async function deleteContent(collection: CollectionWithFields, id: number, actor: HookActor = { userId: null }, trash?: TrashIntent) {
  assertWritable(collection);
  assertDeletable(collection);
  if (hasHooks("record.beforeDelete")) await runBeforeHooks("record.beforeDelete", collection, { actor, values: {}, record: await requireContent(collection, id) });
  const intent = trash === undefined ? await trashIntent(actor.userId) : trash;
  const row = await recordsDb.transaction().execute((trx) => deleteRecordIn(trx, collection, id, intent));
  emitRecordEvent({ collection, action: "delete", row: await toRecord(collection, row) });
}

/** What Settings → Security → Trash says a delete should do. Read outside the write, so no transaction waits on it. */
export async function trashIntent(deletedById: string | null): Promise<TrashIntent> {
  const { enabled, retentionDays } = await trashSettings();
  return enabled ? { retentionDays, deletedById } : null;
}

/**
 * Puts back the links other records had to this one, where nothing has filled them since. The
 * delete cleared them without asking each owner's rules, so restoring them asks nothing either,
 * and it changes no other value, bumps no `updatedAt` and fires no hook, exactly as the delete
 * didn't. A field that now points at another collection is left alone. A list field's id goes
 * back at the end: the place it had isn't kept.
 */
async function restoreInboundLinks(trx: Trx, collection: CollectionWithFields, recordId: number, links: TrashedInboundLink[]) {
  if (!links.length) return;
  const fields = await prisma.field.findMany({ where: { id: { in: [...new Set(links.map((link) => link.fieldId))] } }, include: { collection: { select: { slug: true } } } });
  for (const field of fields) {
    if (referencedCollection(field.type, field.config) !== collection.id) continue;
    const owner = tableName(field.collection.slug);
    const ids = [...new Set(links.filter((link) => link.fieldId === field.id).map((link) => link.recordId))];
    for (const part of chunks(ids)) {
      if (storageOf(field).sql === "json") {
        const list = sql.ref(field.name);
        const rows = await trx.selectFrom(owner).select("id").where("id", "in", part).where(sql<SqlBool>`NOT ${listContains(field.name, [recordId])}`).execute();
        const place = rows.map((row) => row.id as number);
        if (!place.length) continue;
        if (isPostgres()) {
          await sql`UPDATE ${sql.table(owner)} SET ${list} = COALESCE(${list}, '[]'::jsonb) || to_jsonb(${recordId}::int) WHERE "id" IN (${sql.join(place)})`.execute(trx);
        } else {
          await sql`UPDATE ${sql.table(owner)} SET ${list} = json_insert(COALESCE(${list}, '[]'), '$[#]', ${recordId}) WHERE "id" IN (${sql.join(place)})`.execute(trx);
        }
      } else {
        await trx.updateTable(owner).set({ [field.name]: recordId }).where("id", "in", part).where(field.name, "is", null).execute();
      }
    }
  }
}

/**
 * Puts a trashed record back under its own id, so links to it and its files' addresses still
 * match, and removes the entry. It goes through the same validation as a new record, since the
 * collection may have changed since the delete, and through the review gate, since it may come
 * back published. The files it used are attached again without asking the restorer for a claim
 * on them, as restoring a revision doesn't either. History before the delete is not brought back.
 */
export async function restoreFromTrash(collection: CollectionWithFields, entry: TrashedRecord, actor: FileActor) {
  assertWritable(collection);
  const snapshot = snapshotOf(entry);
  if (snapshot.version !== 1) throw new HttpError(409, "TRASH_UNREADABLE", "This entry was written by a later version of the CMS and can't be read here.");
  const byId = new Map(collection.fields.map((field) => [String(field.id), field]));
  // Fields the collection no longer has are dropped, as restoring a revision drops them.
  const named = (values: TrashedValues) => Object.fromEntries(Object.entries(values).flatMap(([id, value]) => {
    const field = byId.get(id);
    return field ? [[field.name, value] as const] : [];
  }));
  const shared = named(snapshot.values);
  const localized = isLocalizedCollection(collection);
  const translations = localized ? snapshot.translations ?? [] : [];
  if (localized && !translations.length) throw new HttpError(409, "TRASH_UNREADABLE", "This entry has no translations to put back.");

  // Each language is validated as a new record is, so a field that became required is reported.
  const perLocale = new Map<string, Record<string, unknown>>();
  for (const translation of translations) perLocale.set(translation.locale, await validateRecordValues(collection.fields, { ...shared, ...named(translation.values) }));
  const flat = localized ? perLocale.get(await defaultLocale()) ?? [...perLocale.values()][0] : await validateRecordValues(collection.fields, shared);
  const status = entry.status === "published" ? "published" : "draft";
  assertMayPublish(collection, actor, null, status);
  const claiming: FileActor = { ...actor, canUseAny: true };

  try {
    const row = await recordsDb.transaction().execute(async (trx) => {
      if (collection.scoped) await assertRecordRoom(trx);
      if (await trx.selectFrom(table(collection)).select("id").where("id", "=", entry.recordId).executeTakeFirst()) throw idTaken();
      await trx.insertInto(table(collection)).values({
        ...toColumns(collection, flat, localized ? "shared" : "all"),
        id: entry.recordId,
        status,
        publishedAt: snapshot.publishedAt,
        createdById: snapshot.createdById,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      }).execute();
      // An explicit id doesn't move Postgres's identity sequence, so the next insert would collide.
      if (isPostgres()) await sql`SELECT setval(pg_get_serial_sequence(${table(collection)}, 'id'), (SELECT COALESCE(MAX("id"), 1) FROM ${sql.table(table(collection))}))`.execute(trx);

      for (const translation of translations) {
        const values = perLocale.get(translation.locale)!;
        await trx.insertInto(localeTableName(collection.slug)).values({
          ...toColumns(collection, values, "localized"),
          recordId: entry.recordId,
          locale: translation.locale,
          status: translation.status === "published" ? "published" : "draft",
          publishedAt: translation.publishedAt,
          createdAt: translation.createdAt,
          updatedAt: translation.updatedAt,
          updatedById: translation.updatedById,
          source: typeof translation.source === "string" ? translation.source : null,
        }).execute();
      }

      if (localized) {
        for (const [code, values] of perLocale) {
          await assertReferencesExist(trx, collection, values);
          await syncBlockRefs(trx, collection, entry.recordId, values, code);
          await syncFileRefs(trx, collection, entry.recordId, values, claiming, code);
          await snapshotRecord(trx, collection, toRow(collection, await readWritten(trx, collection, entry.recordId, code)), actor.userId, RESTORE_NOTE, code);
        }
        await indexTranslations(trx, collection, entry.recordId, [...perLocale.keys()]);
      } else {
        await assertReferencesExist(trx, collection, flat);
        await syncBlockRefs(trx, collection, entry.recordId, flat);
        await syncFileRefs(trx, collection, entry.recordId, flat, claiming);
      }
      await restoreInboundLinks(trx, collection, entry.recordId, snapshot.inbound ?? []);
      const written = await trx.selectFrom(await source(collection)).selectAll().where("id", "=", entry.recordId).executeTakeFirstOrThrow();
      if (!localized) {
        await snapshotRecord(trx, collection, toRow(collection, written), actor.userId, RESTORE_NOTE);
        await indexRecord(trx, collection, toRow(collection, written));
      }
      // The entry goes in the same transaction, so a record is never both restored and in the trash.
      await trx.deleteFrom("TrashedRecord").where("id", "=", entry.id).execute();
      await enqueueAfterHooks(trx, collection, "create", await toRecord(collection, written));
      return written;
    });
    const record = await toRecord(collection, row);
    emitRecordEvent({ collection, action: "create", row: record });
    return record;
  } catch (error) {
    // Two restores of the same entry at once: the row the second inserts is already there.
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || (code === "23505" && /_pkey$/.test(constraint ?? ""))) throw idTaken();
    throw fieldError(collection, error);
  }
}

const idTaken = () => new HttpError(409, "RECORD_ID_TAKEN", "A record with this id exists again, so this one can't be put back.");

const RESTORE_NOTE = "Restored from the trash";
