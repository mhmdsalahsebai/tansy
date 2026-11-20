import "server-only";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { sql } from "kysely";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";
import { indexTar, readEntry, readEntryText, TarWriter, type TarEntry } from "../backup/archive";
import { allCollections, type CollectionWithFields } from "../content/access";
import { purgeScopeTrash } from "../content/trash";
import { chunks } from "../content/chunks";
import { encode, recordSearchEntries } from "../content/content-service";
import { recordsDb } from "../content/db";
import { SYSTEM_COLUMNS } from "../content/rule-lookup";
import { decodeColumn, type ColumnType } from "../fields/define";
import { fieldStorage } from "../fields/registry";
import { HttpError } from "../http/errors";
import { isLocalizedCollection } from "../i18n/context";
import { localeTableName, tableName } from "../schema/names";
import { queueSearch, removeLocaleSearchEntry, removeSearchEntry, searchAdapter, wakeSearchQueue, writeLocaleSearchEntry, writeSearchEntry } from "../search";
import { invalidateSiteCache } from "../site/cache";
import { THUMB_SIZES } from "../files/service";
import { adapterNamed, uploadAdapter } from "../storage";
import type { ByteStream } from "../storage/types";
import { isScopeValue, SCOPE_COLUMN, unscoped, withScope } from "./context";

/**
 * One scope value's data as a whole (C33): what it uses, an archive of it, putting such an
 * archive into an empty value, and removing every row and file it has. Every scoped record and
 * its translations, links, revisions, schedules and reviews; its files with their bytes; its
 * redirects, settings and plugin store. Not the schema, which every value shares, nor shared
 * collections' records, users or memberships, which the provider keeps.
 *
 * Record ids are kept, so links between the value's records and its pages' addresses stay as
 * they were. Collections and fields are matched by name, since their ids differ between
 * instances. An import refuses ids another value holds, which happens only when moving into
 * an instance that already has records of its own in the same collections.
 */

const FORMAT = "tansy-scope";
const VERSION = 1;

interface CollectionEntry {
  id: number;
  slug: string;
  localized: boolean;
  fields: Array<{ id: number; name: string }>;
  records: number;
}

interface ScopeManifest {
  format: typeof FORMAT;
  version: number;
  value: string;
  createdAt: string;
  /** Every collection of the instance, so links and fields can be matched by name. Only scoped ones have records here. */
  collections: CollectionEntry[];
  /** Every collection's slug by id, for links to records in collections that aren't exported. */
  slugs: Record<string, string>;
  files: number;
}

export interface ScopeUsage {
  records: number;
  /** Bytes of the value's own files. */
  storageBytes: number;
  files: number;
}

const assertValue = (value: string) => {
  if (!isScopeValue(value)) throw new HttpError(400, "VALIDATION_FAILED", "Not a scope value.");
};

const scopedCollections = async () => (await allCollections()).filter((collection) => collection.scoped && collection.type !== "view") as CollectionWithFields[];

/** Ids of the value's records in one collection, in order. */
async function recordIds(collection: CollectionWithFields, value: string): Promise<number[]> {
  const rows = await withScope(value, () => recordsDb.selectFrom(tableName(collection.slug)).select("id").orderBy("id").execute());
  return rows.map((row) => Number(row.id));
}

/**
 * How many records the value holds across scoped collections. `db` is the caller's transaction
 * when it holds one: SQLite has one connection, so counting outside it would wait on itself.
 */
export async function scopeRecordCount(value: string, db: typeof recordsDb = recordsDb): Promise<number> {
  assertValue(value);
  let records = 0;
  for (const collection of await scopedCollections()) {
    const row = await withScope(value, () => db.selectFrom(tableName(collection.slug)).select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst());
    records += Number(row?.count ?? 0);
  }
  return records;
}

/** How much one value holds, for limits. */
export async function scopeUsage(value: string): Promise<ScopeUsage> {
  const records = await scopeRecordCount(value);
  const files = await prisma.storedFile.aggregate({ where: { scope: value }, _sum: { size: true }, _count: { _all: true } });
  return { records, storageBytes: Number(files._sum.size ?? 0), files: files._count._all };
}

/** Column kinds of a record table and its translations, so values read on one database are written right on the other. */
function columnKinds(collection: CollectionWithFields): Map<string, ColumnType> {
  const kinds = new Map<string, ColumnType>(SYSTEM_COLUMNS);
  for (const [name, kind] of [["recordId", "integer"], ["locale", "text"], ["updatedById", "text"], ["source", "text"]] as const) kinds.set(name, kind);
  for (const field of collection.fields) kinds.set(field.name, fieldStorage(field).sql);
  return kinds;
}

/** Rows read the same on both databases (core/content/db.ts), except booleans and JSON, which are decoded here. */
function portable(row: Record<string, unknown>, kinds: Map<string, ColumnType>) {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(row)) {
    if (name === SCOPE_COLUMN) continue;
    const kind = kinds.get(name);
    out[name] = kind ? decodeColumn(kind, raw) : raw instanceof Date ? raw.toISOString() : raw;
  }
  return out;
}

const writable = (row: Record<string, unknown>, kinds: Map<string, ColumnType>) =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== SCOPE_COLUMN).map(([name, value]) => {
    const kind = kinds.get(name);
    return [name, kind ? encode(kind, value) : value];
  }));

/** Rows per insert, well within SQLite's limit on bound parameters however many fields a collection has. */
const slices = <T>(items: T[], size = 50) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const jsonLines = (rows: unknown[]) => Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
const parseLines = (text: string) => text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);

async function streamOf(body: ByteStream | null): Promise<Readable> {
  if (!body) throw new Error("A file's bytes are missing from storage.");
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

/**
 * Writes the value's data to a .tar.gz in a temporary folder. The caller sends or moves the
 * file, then calls `cleanup`. Runs across every value, reading only this one's rows.
 */
export async function exportScope(value: string): Promise<{ path: string; name: string; cleanup(): Promise<void> }> {
  assertValue(value);
  return unscoped("exporting one scope value", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cms-scope-"));
    const name = `cms-scope-${value}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.tar.gz`;
    const file = path.join(directory, name);
    const cleanup = () => rm(directory, { recursive: true, force: true });
    try {
      const gzip = createGzip();
      const done = pipeline(gzip, createWriteStream(file));
      const tar = new TarWriter(gzip);
      const all = await allCollections();
      const entries: CollectionEntry[] = [];
      const exported = new Map<number, number[]>();
      for (const collection of all.filter((entry) => entry.scoped && entry.type !== "view") as CollectionWithFields[]) {
        const kinds = columnKinds(collection);
        const ids = await recordIds(collection, value);
        exported.set(collection.id, ids);
        const rows: unknown[] = [];
        const translations: unknown[] = [];
        for (const part of chunks(ids)) {
          const found = await withScope(value, () => recordsDb.selectFrom(tableName(collection.slug)).selectAll().where("id", "in", part).orderBy("id").execute());
          rows.push(...found.map((row) => portable(row, kinds)));
          if (isLocalizedCollection(collection)) {
            const local = await withScope(value, () => recordsDb.selectFrom(localeTableName(collection.slug)).selectAll().where("recordId", "in", part).execute());
            translations.push(...local.map((row) => portable(row, kinds)));
          }
        }
        const body = jsonLines(rows);
        await tar.add(`records/${collection.slug}.jsonl`, body.length, body);
        if (isLocalizedCollection(collection)) {
          const text = jsonLines(translations);
          await tar.add(`translations/${collection.slug}.jsonl`, text.length, text);
        }
        entries.push({ id: collection.id, slug: collection.slug, localized: isLocalizedCollection(collection), fields: collection.fields.map(({ id, name: fieldName }) => ({ id, name: fieldName })), records: ids.length });
      }

      // Rows beside the records, keyed by collection and record id.
      const linked: Record<string, unknown[]> = { "record-refs": [], "file-refs": [], revisions: [], schedules: [], reviews: [] };
      for (const [collectionId, ids] of exported) {
        for (const part of chunks(ids)) {
          const source = { sourceCollectionId: collectionId, sourceRecordId: { in: part } };
          const record = { collectionId, recordId: { in: part } };
          linked["record-refs"].push(...await prisma.recordRef.findMany({ where: source, omit: { id: true } }));
          linked["file-refs"].push(...await prisma.fileRef.findMany({ where: source, omit: { id: true } }));
          linked.revisions.push(...await prisma.revision.findMany({ where: record, omit: { id: true } }));
          linked.schedules.push(...await prisma.scheduledAction.findMany({ where: record, omit: { id: true } }));
          linked.reviews.push(...await prisma.reviewRequest.findMany({ where: record, omit: { id: true } }));
        }
      }
      for (const [entry, rows] of Object.entries(linked)) {
        const body = jsonLines(rows);
        await tar.add(`system/${entry}.jsonl`, body.length, body);
      }

      const suffix = `@${value}`;
      const files = await prisma.storedFile.findMany({ where: { scope: value } });
      const system: Record<string, unknown[]> = {
        files,
        redirects: await prisma.redirect.findMany({ where: { scope: value }, omit: { id: true } }),
        settings: await prisma.appSetting.findMany({ where: { key: { endsWith: suffix } } }),
        "plugin-data": await prisma.pluginData.findMany({ where: { plugin: { endsWith: suffix } } }),
      };
      for (const [entry, rows] of Object.entries(system)) {
        const body = jsonLines(rows);
        await tar.add(`system/${entry}.jsonl`, body.length, body);
      }
      for (const stored of files) {
        const bytes = await adapterNamed(stored.storage).get(stored.key);
        await tar.add(`blobs/${stored.id}`, stored.size, await streamOf(bytes));
      }

      const manifest: ScopeManifest = {
        format: FORMAT,
        version: VERSION,
        value,
        createdAt: new Date().toISOString(),
        collections: entries,
        slugs: Object.fromEntries(all.map((collection) => [String(collection.id), collection.slug])),
        files: files.length,
      };
      const body = Buffer.from(JSON.stringify(manifest, null, 2));
      await tar.add("manifest.json", body.length, body);
      await tar.finish();
      await done;
      return { path: file, name, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  });
}

async function openArchive(file: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "cms-scope-import-"));
  const tar = path.join(directory, "archive.tar");
  try {
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(tar));
    const entries = await indexTar(tar);
    const read = async (name: string) => {
      const entry = entries.get(name);
      return entry ? parseLines(await readEntryText(tar, entry)) : [];
    };
    const manifestEntry = entries.get("manifest.json");
    if (!manifestEntry) throw new HttpError(400, "NOT_A_SCOPE_ARCHIVE", "This isn't an export of one scope value.");
    const manifest = JSON.parse(await readEntryText(tar, manifestEntry)) as ScopeManifest;
    if (manifest.format !== FORMAT || manifest.version !== VERSION) throw new HttpError(400, "NOT_A_SCOPE_ARCHIVE", "This isn't an export of one scope value, or it was made by another version.");
    return { tar, entries, manifest, read, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "NOT_A_SCOPE_ARCHIVE", "The archive couldn't be read.");
  }
}

const conflict = (message: string) => new HttpError(409, "SCOPE_IMPORT_CONFLICT", message);

/**
 * Puts an archive from `exportScope` into `value`, which must exist and hold nothing yet. The
 * value can differ from the one exported. Anything that fails part-way is removed again, so
 * the value is empty or whole.
 */
export async function importScope(value: string, file: string): Promise<{ records: number; files: number }> {
  assertValue(value);
  const archive = await openArchive(file);
  try {
    return await unscoped("importing one scope value", async () => {
      const { manifest, read, tar, entries } = archive;
      const here = new Map((await allCollections()).map((collection) => [collection.slug, collection as CollectionWithFields]));
      // Matched by name: the same collections, scoped here too, with every field the archive has.
      for (const entry of manifest.collections) {
        const target = here.get(entry.slug);
        if (!target || !target.scoped) throw conflict(`"${entry.slug}" isn't a scoped collection here.`);
        const missing = entry.fields.find((field) => !target.fields.some((own) => own.name === field.name));
        if (missing) throw conflict(`"${entry.slug}" has no field "${missing.name}" here.`);
      }
      const usage = await scopeUsage(value);
      if (usage.records || usage.files) throw conflict("Import into a value that holds nothing yet.");

      const recordsOf = new Map<string, Array<Record<string, unknown>>>();
      for (const entry of manifest.collections) {
        const rows = await read(`records/${entry.slug}.jsonl`);
        recordsOf.set(entry.slug, rows);
        const ids = rows.map((row) => Number(row.id));
        for (const part of chunks(ids)) {
          const taken = await recordsDb.selectFrom(tableName(entry.slug)).select("id").where("id", "in", part).limit(1).execute();
          if (taken.length) throw conflict(`Records in "${entry.slug}" have ids already used here. Import into an instance whose records in it don't overlap, such as a new one.`);
        }
      }
      const files = await read("system/files.jsonl");
      for (const part of chunks(files.map((row) => String(row.id)))) {
        if (await prisma.storedFile.count({ where: { id: { in: part } } })) throw conflict("Files in the archive have ids already used here.");
      }

      try {
        return await place(value, archive, here, recordsOf, files, tar, entries);
      } catch (error) {
        // Leave the value as it was: empty.
        await purgeScope(value).catch((cleanup: unknown) => console.error("[scope] cleaning up a failed import", cleanup));
        throw error;
      }
    });
  } finally {
    await archive.cleanup();
  }
}

async function indexRecord(collection: CollectionWithFields, id: number) {
  if (searchAdapter()) {
    await queueSearch(recordsDb, collection.id, id);
    return wakeSearchQueue();
  }
  const entries = await recordSearchEntries(collection, id);
  await recordsDb.transaction().execute(async (trx) => {
    for (const entry of entries ?? []) {
      if (entry.locale === undefined) await writeSearchEntry(trx, collection.id, id, entry.text);
      else await writeLocaleSearchEntry(trx, collection.id, id, entry.locale, entry.text);
    }
  });
}

async function place(
  value: string,
  { manifest, read }: Awaited<ReturnType<typeof openArchive>>,
  here: Map<string, CollectionWithFields>,
  recordsOf: Map<string, Array<Record<string, unknown>>>,
  files: Array<Record<string, unknown>>,
  tar: string,
  entries: Map<string, TarEntry>,
) {
  const adapter = uploadAdapter();
  // Files first, so records can name them.
  for (const row of files) {
    const id = String(row.id);
    const entry = entries.get(`blobs/${id}`);
    if (!entry) throw new HttpError(400, "NOT_A_SCOPE_ARCHIVE", "A file's bytes are missing from the archive.");
    const key = `files/${value}/${id.slice(0, 2)}/${id}`;
    await adapter.put(key, Readable.toWeb(readEntry(tar, entry)) as ByteStream, { size: entry.size, contentType: String(row.type) });
    await prisma.storedFile.create({
      data: {
        id, scope: value, storage: adapter.name, key, name: String(row.name), type: String(row.type), size: Number(row.size),
        width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height),
        createdById: (row.createdById as string | null) ?? null, createdAt: new Date(String(row.createdAt)), temporary: row.temporary === true,
      },
    });
  }

  let records = 0;
  await withScope(value, async () => {
    for (const entry of manifest.collections) {
      const collection = here.get(entry.slug)!;
      const kinds = columnKinds(collection);
      const rows = recordsOf.get(entry.slug) ?? [];
      for (const part of slices(rows)) await recordsDb.insertInto(tableName(entry.slug)).values(part.map((row) => writable(row, kinds))).execute();
      records += rows.length;
      if (entry.localized && isLocalizedCollection(collection)) {
        const translations = await read(`translations/${entry.slug}.jsonl`);
        for (const part of slices(translations)) await recordsDb.insertInto(localeTableName(entry.slug)).values(part.map((row) => writable(row, kinds))).execute();
      }
      // Ids were given, so the next one made here must come after them.
      if (isPostgres() && rows.length) {
        const table = tableName(entry.slug);
        await sql`SELECT setval(pg_get_serial_sequence(${`"${table}"`}, 'id'), GREATEST((SELECT MAX("id") FROM ${sql.table(table)}), 1))`.execute(recordsDb);
      }
    }
  });

  // Collection and field ids by name, from the archive's instance to this one.
  const collectionId = new Map<number, number>();
  const fieldId = new Map<number, number>();
  const bySlug = new Map([...here.values()].map((collection) => [collection.slug, collection]));
  for (const [id, slug] of Object.entries(manifest.slugs)) {
    const target = bySlug.get(slug);
    if (target) collectionId.set(Number(id), target.id);
  }
  for (const entry of manifest.collections) {
    const target = here.get(entry.slug)!;
    for (const field of entry.fields) {
      const own = target.fields.find((candidate) => candidate.name === field.name);
      if (own) fieldId.set(field.id, own.id);
    }
  }
  const mapped = (rows: Array<Record<string, unknown>>, keys: Record<string, Map<number, number>>) => rows.flatMap((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [key, map] of Object.entries(keys)) {
      const to = map.get(Number(row[key]));
      // A link to a collection this instance doesn't have is left out, as its record would be.
      if (to === undefined) return [];
      out[key] = to;
    }
    return [out];
  });
  const dates = (row: Record<string, unknown>, names: string[]) => {
    for (const name of names) if (typeof row[name] === "string") row[name] = new Date(row[name] as string);
    return row;
  };

  const recordRefs = mapped(await read("system/record-refs.jsonl"), { sourceCollectionId: collectionId, targetCollectionId: collectionId, fieldId });
  const fileRefs = mapped(await read("system/file-refs.jsonl"), { sourceCollectionId: collectionId, fieldId });
  const revisions = mapped(await read("system/revisions.jsonl"), { collectionId }).map((row) => dates(row, ["createdAt"]));
  const schedules = mapped(await read("system/schedules.jsonl"), { collectionId }).map((row) => dates(row, ["at", "failedAt", "createdAt"]));
  const reviews = mapped(await read("system/reviews.jsonl"), { collectionId }).map((row) => dates(row, ["submittedAt", "reviewedAt", "createdAt", "updatedAt"]));
  for (const part of chunks(recordRefs)) await prisma.recordRef.createMany({ data: part as Prisma.RecordRefCreateManyInput[] });
  for (const part of chunks(fileRefs)) await prisma.fileRef.createMany({ data: part as Prisma.FileRefCreateManyInput[] });
  for (const part of chunks(revisions)) await prisma.revision.createMany({ data: part as Prisma.RevisionCreateManyInput[] });
  for (const part of chunks(schedules)) await prisma.scheduledAction.createMany({ data: part as Prisma.ScheduledActionCreateManyInput[] });
  for (const part of chunks(reviews)) await prisma.reviewRequest.createMany({ data: part as Prisma.ReviewRequestCreateManyInput[] });

  const suffix = (text: string) => text.replace(/@[A-Za-z0-9_-]+$/, `@${value}`);
  for (const row of await read("system/redirects.jsonl")) {
    await prisma.redirect.create({ data: { ...dates(row, ["createdAt", "updatedAt"]), scope: value } as Prisma.RedirectCreateInput });
  }
  for (const row of await read("system/settings.jsonl")) {
    const key = suffix(String(row.key));
    const data = { value: row.value as Prisma.InputJsonValue };
    await prisma.appSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
  }
  for (const row of await read("system/plugin-data.jsonl")) {
    const plugin = suffix(String(row.plugin));
    const key = String(row.key);
    const data = { value: row.value as Prisma.InputJsonValue };
    await prisma.pluginData.upsert({ where: { plugin_key: { plugin, key } }, create: { plugin, key, ...data }, update: data });
  }

  // Search entries for the records now stored, without touching other values' entries.
  for (const entry of manifest.collections) {
    const collection = here.get(entry.slug)!;
    for (const row of recordsOf.get(entry.slug) ?? []) await indexRecord(collection, Number(row.id));
  }
  invalidateSiteCache();
  return { records, files: files.length };
}

/**
 * Removes every row and file the value has: its records with their links, revisions,
 * schedules, reviews, search entries and pending hooks, its files and their bytes, redirects,
 * settings, plugin store, webhooks and audit entries. The provider removes the value itself.
 * Safe to run again after a failure part-way.
 */
export async function purgeScope(value: string): Promise<{ records: number; files: number }> {
  assertValue(value);
  return unscoped("purging one scope value", async () => {
    let records = 0;
    for (const collection of await scopedCollections()) {
      const ids = await recordIds(collection, value);
      records += ids.length;
      const localized = isLocalizedCollection(collection);
      for (const part of chunks(ids)) {
        await prisma.recordRef.deleteMany({ where: { OR: [{ sourceCollectionId: collection.id, sourceRecordId: { in: part } }, { targetCollectionId: collection.id, targetRecordId: { in: part } }] } });
        await prisma.fileRef.deleteMany({ where: { sourceCollectionId: collection.id, sourceRecordId: { in: part } } });
        const record = { collectionId: collection.id, recordId: { in: part } };
        await prisma.revision.deleteMany({ where: record });
        await prisma.scheduledAction.deleteMany({ where: record });
        await prisma.reviewRequest.deleteMany({ where: record });
        await prisma.hookDelivery.deleteMany({ where: record });
        await recordsDb.transaction().execute(async (trx) => {
          for (const id of part) {
            if (localized) await removeLocaleSearchEntry(trx, collection.id, id);
            await removeSearchEntry(trx, collection.id, id);
          }
        });
        await withScope(value, async () => {
          if (localized) await recordsDb.deleteFrom(localeTableName(collection.slug)).where("recordId", "in", part).execute();
          await recordsDb.deleteFrom(tableName(collection.slug)).where("id", "in", part).execute();
        });
      }
    }

    // The value's trash goes before its files, which its entries hold (core/content/trash.ts).
    await purgeScopeTrash(value);

    const files = await prisma.storedFile.findMany({ where: { scope: value } });
    for (const part of chunks(files)) {
      const ids = part.map((file) => file.id);
      await prisma.fileRef.deleteMany({ where: { fileId: { in: ids } } });
      await prisma.storedFile.deleteMany({ where: { id: { in: ids } } });
      for (const file of part) {
        const adapter = adapterNamed(file.storage);
        const keys = [file.key, ...THUMB_SIZES.map((size) => `thumbs/${file.key}/${size}.webp`)];
        const results = await Promise.allSettled(keys.map((key) => adapter.delete(key)));
        for (const result of results) if (result.status === "rejected") console.error(`[scope] could not delete bytes of file ${file.id}`, result.reason);
      }
    }

    const suffix = `@${value}`;
    await prisma.redirect.deleteMany({ where: { scope: value } });
    await prisma.appSetting.deleteMany({ where: { key: { endsWith: suffix } } });
    await prisma.pluginData.deleteMany({ where: { plugin: { endsWith: suffix } } });
    await prisma.webhook.deleteMany({ where: { scope: value } });
    await prisma.auditLog.deleteMany({ where: { scope: value } });
    // Deliveries for records already gone, written before they were.
    await prisma.hookDelivery.deleteMany({ where: { payload: { contains: `"scope":"${value}"` } } });
    invalidateSiteCache();
    return { records, files: files.length };
  });
}
