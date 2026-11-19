import "server-only";
import { decideRecord, filterWhere, listRuleWhere, loadRuleLookups, type RuleRequest } from "../authz/records";
import { bothFilters } from "../authz/rules/sql";
import type { Principal } from "../authz/principal";
import { validateFilter } from "../authz/rules/evaluate";
import { searchWhere } from "../search";
import { loadBlockCatalog } from "../blocks/service";
import { collectionResolver, declaredLinks, streamLinks, type Block, type BlockCatalog } from "../blocks/stream";
import { fieldOperators, fieldStorage, hasValueRefs, valueSummary } from "../fields/registry";
import { HttpError } from "../http/errors";
import { allCollections, type CollectionWithFields } from "./access";
import { findRecordsById, findRecordsReferencing, listContentPage, recordColumns } from "./content-service";
import { filterPaths, linkedIds, readableColumns, relationCatalog, resolveRelation, resolveRelationFilters, type RelationScope } from "./relations";
import { parseExpand, parseFields, parseSort, pickFields, type RecordListQuery, type RecordViewQuery, type Tree } from "./query";
import { flattenRecord, readableFields, type RecordRow } from "./records";
import { buildRecordPath } from "../urls/pattern";
import { isLocalizedCollection, localizedFields } from "../i18n/context";
import { inLocale } from "../i18n/request";
import { chainFor, localeCatalog } from "../i18n/locales";
import { recordsDb } from "./db";
import { localeTableName } from "../schema/names";
import { decodeColumn } from "../fields/define";
import { holdsRecordPermissionForSome } from "../authz/permissions";
import { sql, type SqlBool } from "kysely";
import { translationStatuses } from "../i18n/storage";
import { outdatedFields, parseSource } from "../i18n/outdated";
import { fileTextIn, type FileText } from "../files/text";
import { fileFocusOf, type FileFocus } from "../files/focus";
import prisma from "../../lib/prisma";
import { chunks } from "./chunks";

type Field = CollectionWithFields["fields"][number];
type Presented = Record<string, unknown>;
type Linked = Presented | Presented[];
/** A relation's records, or for a stream field, each block's links by block id and field name. */
type Expanded = Record<string, Linked | Record<string, Record<string, Linked>>>;

/** Caps each relation at each level, so one request's work stays bounded. */
const MAX_EXPANDED_PER_RELATION = 1000;

interface Scope {
  principal: Principal;
  request: RuleRequest;
  collections: CollectionWithFields[];
  catalog?: Promise<BlockCatalog>;
}

/**
 * Why a caller's filter can't run: a column they can't read, an operator its field type
 * doesn't offer, or a relation it may not follow. `relations` names the relations this
 * filter may follow, from relationCatalog; without it, paths that leave the record are
 * refused, because only a resolved relation condition can answer one.
 */
export function callerFilterProblem(collection: CollectionWithFields, principal: Principal, filter: string, relations?: ReadonlyMap<string, ReadonlySet<string>>) {
  const limits = new Map(collection.fields.flatMap((field) => {
    const allowed = fieldOperators(field.type);
    return allowed ? [[field.name, allowed] as const] : [];
  }));
  if (!relations?.size) {
    for (const { operand } of filterPaths(filter)) {
      const reference = readableFields(collection, principal).find((field) => field.name === operand.path[0] && storageOf(field).references);
      if (reference) return `"${operand.path[0]}" is a relation, and a filter here can't follow one.`;
    }
  }
  return validateFilter(filter, readableColumns(collection, principal), limits, relations);
}

/** A flat record: system columns, then each field the caller may read. */
function present(collection: CollectionWithFields, row: RecordRow, principal: Principal, expand?: Expanded): Presented {
  const values = Object.fromEntries(readableFields(collection, principal, row).map((field) => [field.name, row[field.name] ?? null]));
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    createdById: row.createdById,
    // The language this record was read in, which can differ from the one asked for when it fell back.
    ...(isLocalizedCollection(collection) && typeof row.locale === "string" ? { locale: row.locale } : {}),
    ...values,
    ...(expand && Object.keys(expand).length ? { expand } : {}),
  };
}

type Translations = Map<number, { locales: string[]; values: Record<string, Record<string, unknown>>; statuses: Record<string, string> }>;

/**
 * `?locale=*`: each localized field as `{ en: …, fr: … }`. Every language's translation
 * passes the view rule on its own, so a draft the caller can't see is left out, and
 * hidden languages only reach staff.
 */
async function allTranslations(collection: CollectionWithFields, rows: RecordRow[], principal: Principal, request: RuleRequest): Promise<Translations> {
  const result: Translations = new Map();
  if (!rows.length || !isLocalizedCollection(collection)) return result;
  const catalog = await localeCatalog();
  const staff = holdsRecordPermissionForSome(principal.permissions, "record:read", collection.id);
  const readable = new Set(readableFields(collection, principal).map((field) => field.name));
  const fields = localizedFields(collection);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const stored = await recordsDb.selectFrom(localeTableName(collection.slug)).selectAll().where("recordId", "in", rows.map((row) => row.id)).orderBy("locale").execute();
  for (const translation of stored) {
    const code = translation.locale as string;
    if (!catalog.has(code) || (!catalog.isPublic(code) && !staff)) continue;
    const base = byId.get(translation.recordId as number);
    if (!base) continue;
    const candidate: RecordRow = { ...base, locale: code, status: translation.status as string, publishedAt: translation.publishedAt as string | null, updatedAt: translation.updatedAt as string };
    for (const field of fields) candidate[field.name] = decodeColumn(storageOf(field).sql, translation[field.name]);
    if (decideRecord(principal, collection, "view", flattenRecord(candidate), { ...request, locale: code }) !== "allow") continue;
    const entry = result.get(base.id) ?? { locales: [], values: {}, statuses: {} };
    entry.locales.push(code);
    entry.statuses[code] = candidate.status;
    for (const field of fields) if (readable.has(field.name)) (entry.values[field.name] ??= {})[code] = candidate[field.name] ?? null;
    result.set(base.id, entry);
  }
  return result;
}

const storageOf = fieldStorage;

/** One line per readable field whose type declares `summary`, for the record grid. */
function summariesOf(collection: CollectionWithFields, row: RecordRow, principal: Principal) {
  return Object.fromEntries(readableFields(collection, principal).flatMap((field) => {
    const text = valueSummary(field, row[field.name]);
    return text === undefined ? [] : [[field.name, text]];
  }));
}

interface TargetLinks {
  targetCollectionId: number;
  targetRecordIds: number[];
}

/** The linked records this caller may view, by "<collection id>:<record id>". Every one passes its own collection's view rule. */
async function serveLinks(links: TargetLinks[], scope: Scope) {
  const wanted = new Map<number, Set<number>>();
  for (const link of links) {
    const ids = wanted.get(link.targetCollectionId) ?? new Set<number>();
    link.targetRecordIds.forEach((id) => ids.add(id));
    wanted.set(link.targetCollectionId, ids);
  }

  const served = new Map<string, Presented>();
  for (const [targetId, ids] of wanted) {
    const target = scope.collections.find((c) => c.id === targetId);
    if (!target) continue;
    for (const row of await findRecordsById(target, [...ids].slice(0, MAX_EXPANDED_PER_RELATION))) {
      if (decideRecord(scope.principal, target, "view", flattenRecord(row), scope.request) === "allow") served.set(`${targetId}:${row.id}`, present(target, row, scope.principal));
    }
  }
  return served;
}

/** Serves the links a field's value declares through `refs`. Always a list, since a value can link to several collections. */
async function expandDeclared(field: Field, rows: RecordRow[], result: Map<number, Expanded>, scope: Scope) {
  const resolve = collectionResolver(scope.collections);
  const perRow = rows.map((row) => ({ id: row.id, links: declaredLinks(field, row[field.name], resolve) }));
  const served = await serveLinks(perRow.flatMap((row) => row.links), scope);
  for (const { id, links } of perRow) {
    const records = links.flatMap(({ targetCollectionId, targetRecordIds }) => targetRecordIds.map((recordId) => served.get(`${targetCollectionId}:${recordId}`))).filter((record) => record !== undefined);
    if (records.length) result.get(id)![field.name] = records;
  }
}

/** Serves links held inside blocks, under the same per-record view rule as any other expansion. */
async function expandStream(field: Field, rows: RecordRow[], result: Map<number, Expanded>, scope: Scope) {
  const catalog = await (scope.catalog ??= loadBlockCatalog());
  const resolve = collectionResolver(scope.collections);
  const perRow = rows.map((row) => ({ id: row.id, links: Array.isArray(row[field.name]) ? streamLinks(row[field.name] as Block[], catalog, resolve) : [] }));
  const served = await serveLinks(perRow.flatMap((row) => row.links), scope);

  for (const { id, links } of perRow) {
    // A Map, because block ids come from authors and "__proto__" is a legal one.
    const byBlock = new Map<string, Record<string, Linked>>();
    for (const { blockId, field: name, multiple, targetCollectionId, targetRecordIds } of links) {
      const records = targetRecordIds.map((recordId) => served.get(`${targetCollectionId}:${recordId}`)).filter((record) => record !== undefined);
      if (!records.length) continue;
      const entry = byBlock.get(blockId);
      // A `refs` field can produce one link per target collection, all under its one name.
      byBlock.set(blockId, { ...entry, [name]: multiple ? [...((entry?.[name] ?? []) as Presented[]), ...records] : records[0] });
    }
    if (byBlock.size) result.get(id)![field.name] = Object.fromEntries(byBlock);
  }
}

/** Fills in relations level by level. Every record served passes its own collection's view rule. */
async function expandRows(collection: CollectionWithFields, rows: RecordRow[], tree: Tree, scope: Scope) {
  const result = new Map<number, Expanded>(rows.map((row) => [row.id, {}]));
  for (const [segment, children] of tree) {
    const stream = readableFields(collection, scope.principal).find((field) => field.name === segment && field.type === "stream");
    if (stream) {
      if (children.size) throw new HttpError(400, "INVALID_EXPAND", `Links inside "${segment}" expand one level.`);
      await expandStream(stream, rows, result, scope);
      continue;
    }
    const declaring = readableFields(collection, scope.principal).find((field) => field.name === segment && hasValueRefs(field.type) && !storageOf(field).references);
    if (declaring) {
      if (children.size) throw new HttpError(400, "INVALID_EXPAND", `Links inside "${segment}" expand one level.`);
      await expandDeclared(declaring, rows, result, scope);
      continue;
    }
    const relation = resolveRelation(collection, segment, scope);
    const { target, column, multiple, reverse } = relation;
    const fetched = reverse
      ? await findRecordsReferencing(target, column, multiple, rows.map((row) => row.id), MAX_EXPANDED_PER_RELATION)
      : await findRecordsById(target, [...new Set(rows.flatMap((row) => linkedIds(row[column])))].slice(0, MAX_EXPANDED_PER_RELATION));

    const allowed = fetched.filter((row) => decideRecord(scope.principal, target, "view", flattenRecord(row), scope.request) === "allow");
    const nested = children.size ? await expandRows(target, allowed, children, scope) : undefined;
    const served = new Map(allowed.map((row) => [row.id, present(target, row, scope.principal, nested?.get(row.id))]));

    if (reverse) {
      for (const row of allowed) {
        for (const parent of linkedIds(row[column])) {
          const slot = result.get(parent);
          if (slot) ((slot[segment] ??= []) as Presented[]).push(served.get(row.id)!);
        }
      }
      continue;
    }
    for (const row of rows) {
      const linked = linkedIds(row[column]).map((id) => served.get(id)).filter((record) => record !== undefined);
      if (!linked.length) continue;
      result.get(row.id)![segment] = multiple ? linked : linked[0];
    }
  }
  return result;
}

/**
 * The text of the files each record uses, and where each picture's subject is, by record id and
 * then file id, so a client renders an image's alternative text and crop with the record rather
 * than asking per file. Only files in fields this caller may read, and in a localized collection
 * only the languages the record was read in, since a localized field's files belong to that
 * translation. `FileRef` covers files inside blocks too.
 */
async function fileTextByRecord(collection: CollectionWithFields, rows: RecordRow[], principal: Principal, chain: readonly string[]) {
  const carriers = collection.fields.filter((field) => field.type === "stream" || storageOf(field).files || hasValueRefs(field.type));
  if (!rows.length || !carriers.length) return undefined;
  const readable = new Set(readableFields(collection, principal).map((field) => field.id));
  if (!carriers.some((field) => readable.has(field.id))) return undefined;

  const refs: Array<{ fileId: string; sourceRecordId: number; fieldId: number; locale: string }> = [];
  for (const part of chunks(rows.map((row) => row.id))) {
    refs.push(...await prisma.fileRef.findMany({
      where: { sourceCollectionId: collection.id, sourceRecordId: { in: part } },
      select: { fileId: true, sourceRecordId: true, fieldId: true, locale: true },
    }));
  }
  const languageOf = new Map(rows.map((row) => [row.id, typeof row.locale === "string" ? row.locale : ""]));
  const mine = refs.filter((ref) => readable.has(ref.fieldId) && (ref.locale === "" || ref.locale === languageOf.get(ref.sourceRecordId)));
  if (!mine.length) return undefined;

  const texts = new Map<string, FileText & { focus?: FileFocus }>();
  for (const part of chunks([...new Set(mine.map((ref) => ref.fileId))])) {
    for (const file of await prisma.storedFile.findMany({ where: { id: { in: part } }, select: { id: true, alt: true, caption: true, credit: true, text: true, focusX: true, focusY: true } })) {
      const focus = fileFocusOf(file);
      texts.set(file.id, { ...fileTextIn(file, chain), ...(focus ? { focus } : {}) });
    }
  }
  const byRecord = new Map<number, Record<string, FileText & { focus?: FileFocus }>>();
  for (const ref of mine) {
    const text = texts.get(ref.fileId);
    if (!text) continue;
    (byRecord.get(ref.sourceRecordId) ?? byRecord.set(ref.sourceRecordId, {}).get(ref.sourceRecordId)!)[ref.fileId] = text;
  }
  return byRecord;
}

async function presentAll(collection: CollectionWithFields, rows: RecordRow[], query: RecordViewQuery, principal: Principal, request: RuleRequest) {
  const tree = parseExpand(query.expand);
  const fields = parseFields(query.fields);
  let expanded: Map<number, Expanded> | undefined;
  const translations = query.locale === "*" ? await allTranslations(collection, rows, principal, request) : undefined;
  const statuses = query.translations === "1" ? await translationSummary(collection, rows, principal) : undefined;
  // The text of the files on these records, in the language this read is in. A collection that
  // isn't localized has no chain of its own, so the language asked for decides.
  const files = await fileTextByRecord(collection, rows, principal, collection.locale?.chain ?? (request.locale ? await chainFor(request.locale) : []));
  if (tree.size) {
    // Expansion can reach any collection, each with its own rules, read in the same language.
    const single = collection.locale && collection.locale.chain.length === 1 ? "none" : undefined;
    const collections = await inLocale(await allCollections(), collection.locale && query.locale !== "*" ? collection.locale.code : undefined, single);
    expanded = await expandRows(collection, rows, tree, { principal, request: { ...request, lookups: await loadRuleLookups(collections) }, collections });
  }
  return rows.map((row) => {
    const translated = translations?.get(row.id);
    const record = translations
      ? { ...present(collection, row, principal, expanded?.get(row.id)), ...(translated?.values ?? {}), locales: translated?.locales ?? [], statuses: translated?.statuses ?? {} }
      : present(collection, row, principal, expanded?.get(row.id));
    const picked = fields ? (pickFields(record, fields) as Presented) : record;
    return {
      ...picked,
      ...(query.summaries === "1" ? { summaries: summariesOf(collection, row, principal) } : {}),
      // URL patterns can't use hidden fields, so this reveals nothing the caller couldn't read.
      ...(query.urls === "1" ? { recordPath: collection.urlPattern ? buildRecordPath(collection.urlPattern, row) : null } : {}),
      ...(statuses ? { translations: statuses.get(row.id) ?? [] } : {}),
      ...(files?.get(row.id) ? { files: files.get(row.id) } : {}),
    };
  });
}

/**
 * Each language's status per record, for the grid, with whether it's outdated against the
 * default language's values. Staff only: to anyone else, whether a draft exists is itself
 * something a published page mustn't reveal.
 */
async function translationSummary(collection: CollectionWithFields, rows: RecordRow[], principal: Principal) {
  if (!isLocalizedCollection(collection) || !holdsRecordPermissionForSome(principal.permissions, "record:read", collection.id)) return undefined;
  const catalog = await localeCatalog();
  const fields = localizedFields(collection);
  const stored = await translationStatuses(collection, rows.map((row) => row.id));
  const sources = new Map((await findRecordsById({ ...collection, locale: { code: catalog.defaultLocale, chain: [catalog.defaultLocale], missing: "absent" } }, rows.map((row) => row.id))).map((row) => [row.id, row]));
  return new Map(rows.map((row) => [row.id, (stored.get(row.id) ?? []).filter((entry) => catalog.has(entry.locale)).map((entry) => {
    const source = sources.get(row.id);
    const outdated = entry.locale !== catalog.defaultLocale && source ? outdatedFields(parseSource(entry.source), fields, source).length > 0 : false;
    return { locale: entry.locale, status: entry.status, outdated };
  })]));
}

/** The collections a filter could follow a relation into, read in the language this request reads. */
async function relationScope(collection: CollectionWithFields, query: RecordViewQuery, principal: Principal): Promise<RelationScope> {
  const single = collection.locale && collection.locale.chain.length === 1 ? "none" : undefined;
  const collections = await inLocale(await allCollections(), collection.locale && query.locale !== "*" ? collection.locale.code : undefined, single);
  return { principal, collections };
}

/** The caller is already known not to be locked out; the list rule and any filter narrow the rows. */
export async function listRecords(collection: CollectionWithFields, query: RecordListQuery, principal: Principal, request: RuleRequest) {
  const columns = readableColumns(collection, principal);
  const sort = parseSort(query.sort, columns);

  let where = listRuleWhere(principal, collection, request, recordColumns(collection));
  if (query.filter?.trim()) {
    // Only a filter that names a path needs the catalogue, and only the relations it names are followed.
    const scope = [...filterPaths(query.filter)].length ? await relationScope(collection, query, principal) : undefined;
    const relations = scope && relationCatalog(collection, query.filter, scope);
    const problem = callerFilterProblem(collection, principal, query.filter, relations);
    if (problem) throw new HttpError(400, "INVALID_FILTER", problem);
    const resolved = scope && relations?.size ? await resolveRelationFilters(collection, query.filter, scope, request) : undefined;
    where = bothFilters(where, filterWhere(principal, collection, query.filter, request, columns, resolved));
  }

  if (query.translation && isLocalizedCollection(collection)) {
    // Which languages a record has is staff knowledge: a draft's existence is itself unpublished.
    if (!holdsRecordPermissionForSome(principal.permissions, "record:read", collection.id)) throw new HttpError(403, "FORBIDDEN", "Only people who can read every record of this collection can filter by translation.");
    const [code, state] = query.translation.split(":");
    const translated = sql`SELECT "recordId" FROM ${sql.table(localeTableName(collection.slug))} WHERE "locale" = ${code}${state === "missing" ? sql`` : sql` AND "status" = ${state}`}`;
    where = bothFilters(where, { where: state === "missing" ? sql<SqlBool>`"id" NOT IN (${translated})` : sql<SqlBool>`"id" IN (${translated})`, residual: [] });
  }

  if (query.search?.trim()) {
    if (collection.type === "view") throw new HttpError(400, "INVALID_SEARCH", "View collections can't be searched.");
    where = bothFilters(where, await searchWhere(collection.id, query.search, isLocalizedCollection(collection) ? collection.locale?.chain : undefined));
  }

  const { totalItems, items } = await listContentPage(collection, where, { page: query.page, perPage: query.perPage, sort, skipTotal: query.skipTotal });
  return {
    page: query.page,
    perPage: query.perPage,
    totalItems,
    totalPages: query.skipTotal ? -1 : Math.ceil(totalItems / query.perPage),
    items: await presentAll(collection, items, query, principal, request),
  };
}

/** The caller must have passed authorizeRecord for this row. */
export async function viewRecord(collection: CollectionWithFields, row: RecordRow, query: RecordViewQuery, principal: Principal, request: RuleRequest) {
  const [record] = await presentAll(collection, [row], query, principal, request);
  return record;
}
