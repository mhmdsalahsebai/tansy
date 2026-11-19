import { emitEvent } from "../extend/events";
import "server-only";
import { Prisma } from "../../generated/client-sqlite";
import { validateRule } from "../authz/rules/evaluate";
import { fieldStorage, isKnownFieldType, referencedCollection, type Issue } from "../fields/registry";
import { HttpError, notFound } from "../http/errors";
import { LOCK, serializeWrites } from "../content/locks";
import prisma from "../../lib/prisma";
import { cleanLabels, type Labels } from "../i18n/labels";
import { isPostgres } from "../../lib/prisma/kind";
import * as ddl from "./ddl";
import { diffFields, isSynced, type FieldChange, type RequestedField } from "./diff";
import { localeTableName, tableName } from "./names";
import { isLocalizedCollection, localizationOf, type LocalizationConfig } from "../i18n/context";
import { defaultLocale, invalidateLocales } from "../i18n/locales";
import { inspectViewQuery, type ViewColumn } from "./views";
import { inspectPostgresViewQuery } from "./views-postgres";
import { patternShape, urlPatternProblem, type PatternField } from "../urls/pattern";
import { assertScopeProvider, initialScopeValue } from "../scope/provider";
import { reloadScopeRegistry } from "../scope/registry";

type Tx = Prisma.TransactionClient;

const fieldsInOrder = { fields: { orderBy: { id: "asc" } } } satisfies Prisma.CollectionInclude;

/**
 * DDL is transactional on both databases, so a failure leaves schema, metadata and
 * history untouched. One schema change runs at a time, because rules and views
 * checked here can depend on any collection.
 */
const transaction = <T>(work: (tx: Tx) => Promise<T>) => prisma.$transaction(async (tx) => {
  await serializeWrites(tx, LOCK.schema);
  return work(tx);
}, { maxWait: 10_000, timeout: 60_000 });

class Statements {
  readonly executed: string[] = [];
  constructor(private readonly tx: Tx) {}
  async run(...statements: string[]) {
    for (const statement of statements) {
      await this.tx.$executeRawUnsafe(statement);
      this.executed.push(statement);
    }
  }
}

const invalid = (issues: Issue[]) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", issues);

function isConflict(error: unknown) {
  return (error as { code?: string }).code === "P2002";
}

/** A write comes first so no other writer gets between this read and the transaction's own changes. */
async function lockCollection(tx: Tx, id: number) {
  await tx.$executeRaw`UPDATE "Collection" SET "updatedAt" = "updatedAt" WHERE "id" = ${id}`;
  const collection = await tx.collection.findUnique({ where: { id }, include: fieldsInOrder });
  if (!collection) throw notFound("Collection");
  return collection;
}

function record(tx: Tx, entry: { collectionId: number; collectionSlug: string; action: string; changes: Prisma.InputJsonValue; statements: string[]; createdById: string | null }) {
  return tx.schemaMigration.create({ data: entry });
}

/** Reports reference fields pointing at collections that don't exist. */
async function referenceIssues(tx: Tx, changes: FieldChange[]): Promise<Issue[]> {
  const wanted = changes.flatMap((change) => (change.kind === "add" && change.next.storage.references ? [{ index: change.index, id: change.next.storage.references }] : []));
  if (!wanted.length) return [];
  const found = await tx.collection.findMany({ where: { id: { in: wanted.map((w) => w.id) } }, select: { id: true } });
  const existing = new Set(found.map((c) => c.id));
  return wanted.filter((w) => !existing.has(w.id)).map((w) => ({ path: `fields.${w.index}.config.collection`, message: "That collection does not exist." }));
}

async function assertNoDuplicates(tx: Tx, table: string, column: string, index: number, perLocale = false, scoped = false) {
  const rows = await tx.$queryRawUnsafe<unknown[]>(ddl.findDuplicate(table, column, perLocale, scoped));
  if (rows.length) throw new HttpError(409, "CONFLICT", "Existing records have duplicate values.", [{ path: `fields.${index}.config.unique`, message: `${column} has duplicate values${perLocale ? " in one language" : ""}, so it cannot be unique.` }]);
}

/** Bind markers for raw SQL: Postgres numbers them, SQLite's driver takes them in order. */
const at = (position: number) => (isPostgres() ? `$${position}` : "?");

const isMarkedLocalized = (config: unknown) => (config as { localized?: boolean } | null)?.localized === true;

/** A field's links and file uses copied to every translation, when its value starts belonging to each language. */
async function spreadRefs(tx: Tx, collection: { id: number; slug: string }, fieldId: number) {
  const translations = ddl.ident(localeTableName(collection.slug));
  for (const table of ["RecordRef", "FileRef"]) {
    const columns = table === "RecordRef" ? `"sourceCollectionId", "sourceRecordId", "fieldId", "blockId", "targetCollectionId", "targetRecordId"` : `"fileId", "sourceCollectionId", "sourceRecordId", "fieldId", "blockId"`;
    const selected = columns.split(", ").map((column) => `r.${column}`).join(", ");
    await tx.$executeRawUnsafe(`INSERT INTO "${table}" (${columns}, "locale") SELECT ${selected}, t."locale" FROM "${table}" r JOIN ${translations} t ON t."recordId" = r."sourceRecordId" WHERE r."fieldId" = ${at(1)} AND r."locale" = ''`, fieldId);
    await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "fieldId" = ${at(1)} AND "locale" = ''`, fieldId);
  }
}

/** The kept language's links and file uses become the shared field's, and the others go. */
async function gatherRefs(tx: Tx, fieldId: number, kept: string) {
  for (const table of ["RecordRef", "FileRef"]) {
    await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "fieldId" = ${at(1)} AND "locale" <> ${at(2)}`, fieldId, kept);
    await tx.$executeRawUnsafe(`UPDATE "${table}" SET "locale" = '' WHERE "fieldId" = ${at(1)}`, fieldId);
  }
}

/**
 * Moves a field's column from the record table into every translation, which all start
 * with the value the record had, so no language shows less than it did before.
 */
async function localizeColumn(tx: Tx, statements: Statements, collection: { id: number; slug: string; scoped: boolean }, field: { id: number; name: string; unique: boolean; sql: Parameters<typeof ddl.addColumn>[2] }, index: number) {
  const records = tableName(collection.slug);
  const translations = localeTableName(collection.slug);
  if (field.unique) await statements.run(ddl.dropUniqueIndex(collection.id, field.id));
  await statements.run(ddl.addColumn(translations, field.name, field.sql));
  await statements.run(`UPDATE ${ddl.ident(translations)} SET ${ddl.ident(field.name)} = (SELECT r.${ddl.ident(field.name)} FROM ${ddl.ident(records)} r WHERE r."id" = ${ddl.ident(translations)}."recordId")`);
  await statements.run(ddl.dropColumn(records, field.name));
  if (field.unique) {
    await assertNoDuplicates(tx, translations, field.name, index, true, collection.scoped);
    await statements.run(ddl.createUniqueIndex(translations, field.name, collection.id, field.id, true, collection.scoped));
  }
  await spreadRefs(tx, collection, field.id);
}

/** Moves a field's column back to the record table, keeping one language's values. Lossy, so callers ask first. */
async function shareColumn(tx: Tx, statements: Statements, collection: { id: number; slug: string; scoped: boolean }, field: { id: number; name: string; unique: boolean; sql: Parameters<typeof ddl.addColumn>[2] }, index: number, kept: string) {
  const records = tableName(collection.slug);
  const translations = localeTableName(collection.slug);
  if (field.unique) await statements.run(ddl.dropUniqueIndex(collection.id, field.id));
  await statements.run(ddl.addColumn(records, field.name, field.sql));
  await statements.run(ddl.copyFromLocale(records, translations, field.name, kept));
  await statements.run(ddl.dropColumn(translations, field.name));
  if (field.unique) {
    await assertNoDuplicates(tx, records, field.name, index, false, collection.scoped);
    await statements.run(ddl.createUniqueIndex(records, field.name, collection.id, field.id, false, collection.scoped));
  }
  await gatherRefs(tx, field.id, kept);
}

async function applyChanges(tx: Tx, statements: Statements, collection: { id: number; slug: string; scoped: boolean; localization?: Prisma.JsonValue }, changes: FieldChange[]) {
  const localized = isLocalizedCollection(collection);
  const records = tableName(collection.slug);
  const translations = localeTableName(collection.slug);
  const tableFor = (isLocalized: boolean) => (localized && isLocalized ? translations : records);
  const kept = localized ? await defaultLocale() : "";
  for (const change of changes) {
    if (change.kind === "remove") {
      const table = tableFor(isMarkedLocalized(change.field.config));
      await tx.field.delete({ where: { id: change.field.id } });
      // SQLite refuses to drop an indexed column.
      if ((change.field.config as { unique?: boolean } | null)?.unique) await statements.run(ddl.dropUniqueIndex(collection.id, change.field.id));
      await statements.run(ddl.dropColumn(table, change.field.name));
    } else if (change.kind === "update") {
      const { field, next, conversion, wasUnique, index } = change;
      const was = localized && change.wasLocalized;
      const now = localized && next.localized;
      const table = tableFor(was);
      if (field.name !== next.name) await statements.run(ddl.renameColumn(table, field.name, next.name));
      // Rebuilt around a conversion because converted values can newly collide, and around a move between tables.
      const rebuildIndex = wasUnique !== next.unique || (conversion !== null && next.unique) || was !== now;
      if (wasUnique && rebuildIndex) await statements.run(ddl.dropUniqueIndex(collection.id, field.id));
      if (conversion) {
        const using = field.name === next.name ? conversion.using : conversion.using.replaceAll(ddl.ident(field.name), ddl.ident(next.name));
        await statements.run(...ddl.convertColumn(table, next.name, conversion.to, using));
      }
      const moved = { id: field.id, name: next.name, unique: false, sql: next.storage.sql };
      if (!was && now) await localizeColumn(tx, statements, collection, moved, index);
      if (was && !now) await shareColumn(tx, statements, collection, moved, index, kept);
      if (next.unique && rebuildIndex) {
        await assertNoDuplicates(tx, tableFor(now), next.name, index, now, collection.scoped);
        await statements.run(ddl.createUniqueIndex(tableFor(now), next.name, collection.id, field.id, now, collection.scoped));
      }
      await tx.field.update({ where: { id: field.id }, data: { name: next.name, type: next.type, storage: next.storage.sql, config: next.config as Prisma.InputJsonValue } });
    } else {
      const { next } = change;
      const now = localized && next.localized;
      const created = await tx.field.create({ data: { collectionId: collection.id, name: next.name, type: next.type, storage: next.storage.sql, config: next.config as Prisma.InputJsonValue } });
      await statements.run(ddl.addColumn(tableFor(now), next.name, next.storage.sql));
      if (next.unique) await statements.run(ddl.createUniqueIndex(tableFor(now), next.name, collection.id, created.id, now, collection.scoped));
    }
  }
}

function summarize(changes: FieldChange[]) {
  const names = (kind: FieldChange["kind"]) => changes.filter((c) => c.kind === kind).map((c) => (c.kind === "remove" ? c.field.name : c.kind === "update" ? c.next.name : c.kind === "add" ? c.next.name : ""));
  return { added: names("add"), updated: names("update"), removed: names("remove") };
}

export interface NewCollection {
  name: string;
  labels?: Labels | null;
  slug: string;
  description?: string;
  type?: "base" | "singleton";
  urlPattern?: string | null;
  fields: RequestedField[];
  localization?: Partial<LocalizationConfig> | null;
  /** Split by the scope provider's value. Only while one is installed (core/scope). */
  scoped?: boolean;
}

/** A field whose plugin has gone counts as text, so removing a plugin can't lock the schema of a collection addressed through it. */
const patternFields = (fields: Array<{ name: string; type: string; config?: unknown }>): PatternField[] => fields.map((field) => {
  const storage = isKnownFieldType(field.type) ? fieldStorage(field) : { sql: "text", files: false };
  const config = (field.config ?? {}) as { unique?: boolean; hidden?: boolean };
  return { name: field.name, unique: config.unique === true, hidden: config.hidden === true, routable: storage.sql === "text" && !storage.files };
});

function invalidPattern(message: string) {
  return new HttpError(400, "INVALID_URL_PATTERN", message, [{ path: "urlPattern", message }]);
}

async function assertPatternAvailable(tx: Tx, collectionId: number, pattern: string) {
  const others = await tx.collection.findMany({ where: { id: { not: collectionId }, urlPattern: { not: null } }, select: { slug: true, urlPattern: true } });
  const clash = others.find((other) => patternShape(other.urlPattern!) === patternShape(pattern));
  if (clash) {
    const message = `"${clash.slug}" already uses addresses of this shape.`;
    throw new HttpError(409, "CONFLICT", message, [{ path: "urlPattern", message }]);
  }
}

/** After the transaction, so a hook never sees a change that was rolled back. Scoped table names follow slugs, so the registry is read again first. */
const schemaChanged = (event: "schema.afterCreate" | "schema.afterUpdate") => async <T extends { id: number; slug: string; name: string }>(collection: T) => {
  await reloadScopeRegistry();
  emitEvent(event, { collection: { id: collection.id, slug: collection.slug, name: collection.name } });
  return collection;
};

export async function createCollectionSchema(input: NewCollection, createdById: string | null) {
  try {
    return await transaction(async (tx) => {
      const type = input.type ?? "base";
      const localization = input.localization?.enabled ? normalizeLocalization(input.localization) : null;
      const scoped = input.scoped === true;
      if (scoped) assertScopeProvider();
      const collection = await tx.collection.create({ data: { name: input.name, labels: cleanLabels(input.labels) ?? Prisma.DbNull, slug: input.slug, description: input.description, createdById, type, urlPattern: input.urlPattern ?? null, localization: localization ? (localization as unknown as Prisma.InputJsonValue) : Prisma.DbNull, scoped } });
      const statements = new Statements(tx);
      await statements.run(...ddl.createTable(tableName(input.slug), collection.id, scoped));
      if (localization) await statements.run(...ddl.createLocaleTable(localeTableName(input.slug), collection.id, scoped));
      if (type === "singleton") await statements.run(ddl.createSingletonIndex(tableName(input.slug), collection.id, scoped));

      const { changes, issues } = diffFields([], input.fields);
      const missing = await referenceIssues(tx, changes);
      if (issues.length || missing.length) throw invalid([...issues, ...missing]);
      if (input.urlPattern) {
        const problem = urlPatternProblem(input.urlPattern, type, patternFields(input.fields));
        if (problem) throw invalidPattern(problem);
        await assertPatternAvailable(tx, collection.id, input.urlPattern);
      }
      await applyChanges(tx, statements, collection, changes);

      await record(tx, { collectionId: collection.id, collectionSlug: input.slug, action: "create", changes: summarize(changes), statements: statements.executed, createdById });
      return tx.collection.findUniqueOrThrow({ where: { id: collection.id }, include: fieldsInOrder });
    }).then(schemaChanged("schema.afterCreate"));
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, "CONFLICT", "That slug is already in use.");
    throw error;
  }
}

const RULE_KEYS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"] as const;

/** Rules can name fields in other collections through @collection, so every collection's rules are rechecked. */
export async function assertRulesHold(tx: Tx, message: string, change: (catalog: Map<string, Set<string>>) => void, leaving: number[] = [], authFields?: string[]) {
  const customAuth = authFields ?? (await tx.userField.findMany({ select: { name: true } })).map((field) => field.name);
  const collections = await tx.collection.findMany({ include: { fields: { select: { name: true } } } });
  // A localized collection's rules can read the language a record is read in.
  const catalog = new Map(collections.map((c) => [c.slug, new Set([...c.fields.map((f) => f.name), ...(isLocalizedCollection(c) ? ["locale"] : [])])]));
  change(catalog);
  const issues = collections.filter((c) => !leaving.includes(c.id)).flatMap((c) => {
    const own = [...(catalog.get(c.slug) ?? c.fields.map((f) => f.name))];
    return RULE_KEYS.flatMap((key) => {
      const source = c[key];
      const problem = source ? validateRule(source, own, catalog, customAuth) : null;
      return problem ? [{ path: `${c.slug}.${key}`, message: problem }] : [];
    });
  });
  if (issues.length) throw new HttpError(400, "INVALID_RULE", message, issues);
}

const VIEW_CONFLICT = "A view collection depends on this. Update or delete the view first.";

/** Every view's stored SQL must still run. Checking the text catches renames, which both databases would otherwise follow silently. */
async function assertViewsHold(tx: Tx, leaving: number[] = []) {
  const views = await tx.collection.findMany({ where: { type: "view", id: { notIn: leaving } }, select: { slug: true, viewQuery: true } });
  for (const view of views) {
    try {
      await tx.$queryRawUnsafe(`SELECT 1 FROM (${view.viewQuery}\n) AS q LIMIT 0`);
    } catch {
      throw new HttpError(409, "VIEW_DEPENDENCY", VIEW_CONFLICT, [{ path: view.slug, message: VIEW_CONFLICT }]);
    }
  }
}

/** Both databases refuse to drop a column a view selects: SQLite's error names the view, and Postgres says other objects depend on it. */
async function withViewErrors<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (/error in view|other objects depend on it/i.test((error as Error).message ?? "")) throw new HttpError(409, "VIEW_DEPENDENCY", VIEW_CONFLICT);
    throw error;
  }
}

async function recordSchemaSql(tx: Tx, leftOut: ReadonlySet<string>) {
  const objects = await tx.$queryRawUnsafe<Array<{ name: string; sql: string }>>(`SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE 'rec\\_%' ESCAPE '\\' ORDER BY rowid`);
  return objects.filter((object) => !leftOut.has(object.name)).map((object) => object.sql);
}

/**
 * `except` is a view being rewritten, so that it can't select from itself. Scoped tables, and
 * `alsoScoped` about to become one, are left out: a view's SQL isn't narrowed to a scope, so it
 * can't read one (SECURITY_MODEL.md, "Row scopes").
 */
async function inspectView(tx: Tx, rawQuery: string, except?: string, alsoScoped?: string) {
  const scoped = await tx.collection.findMany({ where: { scoped: true }, select: { slug: true } });
  const leftOut = new Set([...scoped.map((c) => tableName(c.slug)), ...(except ? [except] : []), ...(alsoScoped ? [alsoScoped] : [])]);
  if (!isPostgres()) return inspectViewQuery(rawQuery, await recordSchemaSql(tx, leftOut));
  const tables = (await tx.collection.findMany({ select: { slug: true } })).map((c) => tableName(c.slug)).filter((table) => !leftOut.has(table));
  return inspectPostgresViewQuery(rawQuery, tables);
}

/** Refuses to scope a collection a view reads, since the view would read across scopes. */
async function assertNoViewReads(tx: Tx, table: string) {
  const views = await tx.collection.findMany({ where: { type: "view" }, select: { slug: true, viewQuery: true } });
  for (const view of views) {
    if (!view.viewQuery) continue;
    try {
      await inspectView(tx, view.viewQuery, tableName(view.slug), table);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const message = "A view reads this collection, and views can't read scoped collections. Change or delete the view first.";
      throw new HttpError(409, "VIEW_DEPENDENCY", message, [{ path: view.slug, message }]);
    }
  }
}

const CARRIED_OPTIONS = ["hidden", "label", "description", "collection", "allowMultiple", "displayField", "options"];

/** A column copied from a collection keeps its type, so hidden stays hidden and references still expand. Anything computed is plain text. */
function viewFields(columns: ViewColumn[], collections: Array<{ slug: string; fields: Array<{ name: string; type: string; config: Prisma.JsonValue }> }>) {
  return columns.filter(({ name }) => !ddl.SYSTEM_COLUMNS_FOR_VIEWS.includes(name.toLowerCase())).map(({ name, table, column }) => {
    const source = collections.find((candidate) => tableName(candidate.slug) === table)?.fields.find((field) => field.name === column);
    if (!source) return { name, type: "text", config: {} };
    const config = Object.fromEntries(Object.entries((source.config ?? {}) as Record<string, unknown>).filter(([key]) => CARRIED_OPTIONS.includes(key)));
    return { name, type: source.type, config };
  });
}

/** For fields saved before the column kind was recorded. A type whose plugin is already gone stays unset, and reads as text. */
export async function backfillFieldStorage() {
  const fields = await prisma.field.findMany({ where: { storage: null }, select: { id: true, type: true, config: true } });
  for (const field of fields.filter(({ type }) => isKnownFieldType(type))) {
    await prisma.field.update({ where: { id: field.id }, data: { storage: fieldStorage(field).sql } });
  }
}

const allFields = (tx: Tx) => tx.collection.findMany({ select: { slug: true, fields: { select: { name: true, type: true, config: true } } } });

export async function createViewCollection(input: { name: string; labels?: Labels | null; slug: string; description?: string; query: string }, createdById: string | null) {
  try {
    return await transaction(async (tx) => {
      const { query, columns } = await inspectView(tx, input.query);
      const fields = viewFields(columns, await allFields(tx));
      const collection = await tx.collection.create({ data: { name: input.name, labels: cleanLabels(input.labels) ?? Prisma.DbNull, slug: input.slug, description: input.description, createdById, type: "view", viewQuery: query } });
      const statements = new Statements(tx);
      await statements.run(ddl.createViewSql(tableName(input.slug), query, columns.map((column) => column.name)));
      await tx.field.createMany({ data: fields.map((field) => ({ ...field, storage: fieldStorage(field).sql, collectionId: collection.id, config: field.config as Prisma.InputJsonValue })) });
      await record(tx, { collectionId: collection.id, collectionSlug: input.slug, action: "create_view", changes: { fields: fields.map((field) => field.name) }, statements: statements.executed, createdById });
      return tx.collection.findUniqueOrThrow({ where: { id: collection.id }, include: fieldsInOrder });
    }).then(schemaChanged("schema.afterCreate"));
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, "CONFLICT", "That slug is already in use.");
    throw error;
  }
}

/** Fields that keep their name keep their id, so rules and other references to them survive. */
export function updateViewCollection(id: number, rawQuery: string, createdById: string | null) {
  return transaction(async (tx) => {
    const collection = await lockCollection(tx, id);
    if (collection.type !== "view") throw new HttpError(400, "BAD_REQUEST", "This is not a view collection.");
    const table = tableName(collection.slug);
    const { query, columns } = await inspectView(tx, rawQuery, table);
    const fields = viewFields(columns, await allFields(tx));

    await assertRulesHold(tx, "An API rule uses a column this query no longer returns. Update the rule first.", (catalog) => {
      catalog.set(collection.slug, new Set(fields.map((field) => field.name)));
    });

    const statements = new Statements(tx);
    await statements.run(ddl.dropView(table), ddl.createViewSql(table, query, columns.map((column) => column.name)));
    const wanted = new Set(fields.map((field) => field.name));
    await tx.field.deleteMany({ where: { collectionId: id, name: { notIn: [...wanted] } } });
    for (const field of fields) {
      const config = field.config as Prisma.InputJsonValue;
      await tx.field.upsert({ where: { collectionId_name: { collectionId: id, name: field.name } }, create: { ...field, config, collectionId: id }, update: { type: field.type, config } });
    }
    await tx.collection.update({ where: { id }, data: { viewQuery: query } });
    await assertViewsHold(tx);
    await record(tx, { collectionId: id, collectionSlug: collection.slug, action: "update_view", changes: { fields: [...wanted] }, statements: statements.executed, createdById });
    return tx.collection.findUniqueOrThrow({ where: { id }, include: fieldsInOrder });
  }).then(schemaChanged("schema.afterUpdate"));
}

/** Applies a full field list: fields with an id are kept, the rest are added, and any not listed are removed. */
export function updateFieldSchema(id: number, requested: RequestedField[], confirm: boolean, createdById: string | null) {
  return transaction(async (tx) => {
    const collection = await lockCollection(tx, id);
    if (collection.type === "view") throw new HttpError(400, "VIEW_READ_ONLY", "A view's fields come from its query.");
    const { changes, issues, destructive } = diffFields(collection.fields, requested, isLocalizedCollection(collection));
    const missing = await referenceIssues(tx, changes);
    if (issues.length || missing.length) throw invalid([...issues, ...missing]);

    await assertRulesHold(tx, "An API rule uses a field this change removes or renames. Update the rule first.", (catalog) => {
      catalog.set(collection.slug, new Set([...requested.map((field) => field.name), ...(isLocalizedCollection(collection) ? ["locale"] : [])]));
    });

    if (collection.urlPattern) {
      const problem = urlPatternProblem(collection.urlPattern, collection.type, patternFields(requested));
      if (problem) throw invalidPattern(`This change breaks the collection's URL pattern. ${problem}`);
    }

    if (destructive.length && !confirm) throw new HttpError(409, "CONFIRMATION_REQUIRED", "This change would lose data. Resend with confirm set to true.", destructive);

    const statements = new Statements(tx);
    await withViewErrors(() => applyChanges(tx, statements, collection, changes));
    await assertViewsHold(tx);
    const summary = summarize(changes);
    if (changes.length) await record(tx, { collectionId: id, collectionSlug: collection.slug, action: "update_fields", changes: summary, statements: statements.executed, createdById });
    // Streams that start following the default language's blocks, in a collection that already has translations.
    const synced = isLocalizedCollection(collection)
      ? changes.flatMap((change) => (change.kind === "update" && change.wasLocalized && change.next.localized && isSynced(change.next) && !isSynced({ type: change.field.type, config: change.field.config as Record<string, unknown> }) ? [change.next.name] : []))
      : [];
    return { collection: await tx.collection.findUniqueOrThrow({ where: { id }, include: fieldsInOrder }), summary, synced };
  }).then(async ({ synced, ...result }) => {
    await schemaChanged("schema.afterUpdate")(result.collection);
    // After the schema commits, as records are written through their own transactions. Confirmed above, and safe to repeat.
    if (synced.length) await (await import("../content/content-service")).realignSyncedStreams(result.collection.id, synced);
    return result;
  });
}

export async function updateCollectionDetails(id: number, { labels, ...data }: { name?: string; labels?: Labels | null; slug?: string; description?: string; urlPattern?: string | null; reviewRequired?: boolean }, createdById: string | null) {
  try {
    return await transaction(async (tx) => {
      const collection = await lockCollection(tx, id);
      // A view is never written to, so there is nothing to review.
      if (data.reviewRequired && collection.type === "view") throw new HttpError(400, "VIEW_READ_ONLY", "A view has nothing to publish, so it can't require review.");
      if (data.urlPattern && data.urlPattern !== collection.urlPattern) {
        const problem = urlPatternProblem(data.urlPattern, collection.type, patternFields(collection.fields));
        if (problem) throw invalidPattern(problem);
        await assertPatternAvailable(tx, id, data.urlPattern);
      }
      if (data.slug && data.slug !== collection.slug) {
        if (collection.type === "view") throw new HttpError(400, "VIEW_READ_ONLY", "A view's slug can't change. Create a new view instead.");
        const renamed = data.slug;
        await assertRulesHold(tx, "An API rule uses this collection's current slug. Update the rule first.", (catalog) => {
          catalog.set(renamed, catalog.get(collection.slug)!);
          catalog.delete(collection.slug);
        });
        const statements = new Statements(tx);
        await statements.run(ddl.renameTable(tableName(collection.slug), tableName(data.slug)));
        if (isLocalizedCollection(collection)) await statements.run(ddl.renameTable(localeTableName(collection.slug), localeTableName(data.slug)));
        await assertViewsHold(tx);
        await record(tx, { collectionId: id, collectionSlug: data.slug, action: "rename", changes: { from: collection.slug, to: data.slug }, statements: statements.executed, createdById });
      }
      return tx.collection.update({ where: { id }, data: { ...data, ...(labels === undefined ? {} : { labels: cleanLabels(labels) ?? Prisma.DbNull }) }, include: fieldsInOrder });
    }).then(schemaChanged("schema.afterUpdate"));
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, "CONFLICT", "That slug is already in use.");
    throw error;
  }
}

export function dropCollections(ids: number[], createdById: string) {
  return transaction(async (tx) => {
    for (const id of ids) await tx.$executeRaw`UPDATE "Collection" SET "updatedAt" = "updatedAt" WHERE "id" = ${id}`;
    const collections = await tx.collection.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, type: true, localization: true } });
    if (!collections.length) return;

    const others = await tx.field.findMany({ where: { collectionId: { notIn: ids } }, include: { collection: { select: { slug: true } } } });
    const blockers = others.filter((field) => ids.includes(referencedCollection(field.type, field.config) ?? 0));
    if (blockers.length) {
      throw new HttpError(409, "CONFLICT", "Other collections still reference this one.", blockers.map((field) => ({ path: `${field.collection.slug}.${field.name}`, message: "Remove this reference field first." })));
    }

    await assertRulesHold(tx, "An API rule in another collection still uses this one. Update the rule first.", (catalog) => {
      for (const c of collections) catalog.delete(c.slug);
    }, collections.map((c) => c.id));

    const statements = new Statements(tx);
    // Views first, so deleting a view along with the table it reads isn't refused.
    const ordered = [...collections].sort((a, b) => Number(b.type === "view") - Number(a.type === "view"));
    await withViewErrors(() => statements.run(...ordered.flatMap((c) => (c.type === "view" ? [ddl.dropView(tableName(c.slug))] : [ddl.dropTable(tableName(c.slug)), ...(isLocalizedCollection(c) ? [ddl.dropTable(localeTableName(c.slug))] : [])]))));
    await assertViewsHold(tx, collections.map((c) => c.id));
    await tx.collection.deleteMany({ where: { id: { in: collections.map((c) => c.id) } } });
    await tx.schemaMigration.createMany({
      data: collections.map((c) => ({ collectionId: c.id, collectionSlug: c.slug, action: "delete", changes: {}, statements: statements.executed, createdById })),
    });
    return collections;
  }).then(async (dropped) => {
    await reloadScopeRegistry();
    for (const { id, slug } of dropped ?? []) emitEvent("schema.afterDelete", { collection: { id, slug } });
  });
}

const normalizeLocalization = (input: Partial<LocalizationConfig>): LocalizationConfig => ({
  enabled: true,
  fallback: input.fallback === "none" ? "none" : "chain",
  fieldFallback: input.fieldFallback === true,
});

/**
 * Turns localization on or off, or changes how a collection falls back. Turning it on
 * gives every record a translation in the default language, holding its status, and
 * moves the fields already marked localized into it. Turning it off keeps the default
 * language's values and deletes the other translations, so it needs `confirm`.
 */
export function updateCollectionLocalization(id: number, input: Partial<LocalizationConfig>, confirm: boolean, createdById: string | null) {
  return transaction(async (tx) => {
    const collection = await lockCollection(tx, id);
    if (collection.type === "view") throw new HttpError(400, "VIEW_READ_ONLY", "View collections can't be localized.");
    const was = localizationOf(collection);
    const wanted = input.enabled === false ? null : normalizeLocalization({ ...was, ...input });
    const records = tableName(collection.slug);
    const translations = localeTableName(collection.slug);
    const primary = await defaultLocale();
    const statements = new Statements(tx);
    const marked = collection.fields.filter((field) => isMarkedLocalized(field.config));
    const column = (field: (typeof marked)[number]) => ({ id: field.id, name: field.name, unique: (field.config as { unique?: boolean } | null)?.unique === true, sql: fieldStorage(field).sql });

    if (!was && wanted) {
      if (collection.fields.some((field) => field.name.toLowerCase() === "locale")) {
        throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path: "localization", message: 'Rename the field called "locale" first: localized records use that name for their language.' }]);
      }
      await statements.run(...ddl.createLocaleTable(translations, collection.id, collection.scoped));
      await statements.run(ddl.seedLocaleRows(translations, records, primary, collection.scoped));
      for (const [index, field] of marked.entries()) await localizeColumn(tx, statements, collection, column(field), index);
      await tx.$executeRawUnsafe(`UPDATE "Revision" SET "locale" = ${at(1)} WHERE "collectionId" = ${at(2)} AND "locale" = ''`, primary, id);
      await tx.$executeRawUnsafe(`UPDATE "ScheduledAction" SET "locale" = ${at(1)} WHERE "collectionId" = ${at(2)} AND "locale" = ''`, primary, id);
    } else if (was && !wanted) {
      const others = await tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${ddl.ident(translations)} WHERE "locale" <> ${at(1)} LIMIT 1`, primary);
      if (others.length && !confirm) throw new HttpError(409, "CONFIRMATION_REQUIRED", "This change would lose data. Resend with confirm set to true.", [{ path: "localization", message: `Turning localization off keeps ${primary} and deletes every other translation.` }]);
      for (const [index, field] of marked.entries()) await shareColumn(tx, statements, collection, column(field), index, primary);
      await statements.run(ddl.mirrorDefaultStatus(records, translations, primary));
      await statements.run(ddl.dropTable(translations));
      await tx.$executeRawUnsafe(`DELETE FROM "Revision" WHERE "collectionId" = ${at(1)} AND "locale" <> ${at(2)}`, id, primary);
      await tx.$executeRawUnsafe(`UPDATE "Revision" SET "locale" = '' WHERE "collectionId" = ${at(1)}`, id);
      await tx.$executeRawUnsafe(`DELETE FROM "ScheduledAction" WHERE "collectionId" = ${at(1)} AND "locale" <> ${at(2)}`, id, primary);
      await tx.$executeRawUnsafe(`UPDATE "ScheduledAction" SET "locale" = '' WHERE "collectionId" = ${at(1)}`, id);
    }

    await assertViewsHold(tx);
    await tx.collection.update({ where: { id }, data: { localization: wanted ? (wanted as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    if (Boolean(was) !== Boolean(wanted)) {
      await record(tx, { collectionId: id, collectionSlug: collection.slug, action: wanted ? "localize" : "unlocalize", changes: { fields: marked.map((field) => field.name), locale: primary }, statements: statements.executed, createdById });
    }
    return { collection: await tx.collection.findUniqueOrThrow({ where: { id }, include: fieldsInOrder }), reindex: Boolean(was) !== Boolean(wanted) };
  }).then(async (result) => {
    invalidateLocales();
    await schemaChanged("schema.afterUpdate")(result.collection);
    if (result.reindex) {
      const { reindexCollection } = await import("../content/content-service");
      void reindexCollection(result.collection).catch((error) => console.error("[search] reindex failed", error));
    }
    return result.collection;
  });
}

/**
 * Turns row scopes on or off for one collection (core/scope). On: its tables get the scope
 * column, every existing record goes to the provider's first value, and unique fields and a
 * singleton's one record become per value. Off: only while every record holds the same value,
 * so two scopes' records are never merged.
 */
export async function updateCollectionScope(id: number, scoped: boolean, createdById: string | null) {
  const value = scoped ? await initialScopeValue() : null;
  return transaction(async (tx) => {
    const collection = await lockCollection(tx, id);
    if (collection.type === "view") throw new HttpError(400, "VIEW_READ_ONLY", "A view reads other collections, so it can't be scoped.");
    if (collection.scoped === scoped) return { collection, changed: false };
    const records = tableName(collection.slug);
    const translations = localeTableName(collection.slug);
    const localized = isLocalizedCollection(collection);
    const statements = new Statements(tx);

    if (scoped) await assertNoViewReads(tx, records);
    else {
      const [{ values }] = await tx.$queryRawUnsafe<Array<{ values: number | bigint }>>(ddl.countScopes(records));
      if (Number(values) > 1) throw new HttpError(409, "SCOPE_VALUES_REMAIN", "Records in this collection belong to more than one scope value. Move or delete them first.");
    }
    // Every index that includes the column has to go before it can be added to or dropped.
    const unique = collection.fields.filter((field) => (field.config as { unique?: boolean } | null)?.unique === true);
    for (const field of unique) await statements.run(ddl.dropUniqueIndex(collection.id, field.id));
    if (collection.type === "singleton") await statements.run(ddl.dropSingletonIndex(collection.id));
    if (scoped) {
      await statements.run(...ddl.addScope(records, `sc_${collection.id}`), ddl.fillScope(records, value!));
      if (localized) await statements.run(...ddl.addScope(translations, `sl_${collection.id}`), ddl.fillScope(translations, value!));
    } else {
      await statements.run(...ddl.dropScope(records, `sc_${collection.id}`));
      if (localized) await statements.run(...ddl.dropScope(translations, `sl_${collection.id}`));
    }
    for (const field of unique) {
      const perLocale = localized && isMarkedLocalized(field.config);
      await statements.run(ddl.createUniqueIndex(perLocale ? translations : records, field.name, collection.id, field.id, perLocale, scoped));
    }
    if (collection.type === "singleton") await statements.run(ddl.createSingletonIndex(records, collection.id, scoped));

    const updated = await tx.collection.update({ where: { id }, data: { scoped }, include: fieldsInOrder });
    await record(tx, { collectionId: id, collectionSlug: collection.slug, action: scoped ? "scope" : "unscope", changes: scoped ? { value } : {}, statements: statements.executed, createdById });
    return { collection: updated, changed: true };
  }).then(async ({ collection, changed }) => {
    if (changed) await schemaChanged("schema.afterUpdate")(collection);
    return collection;
  });
}
