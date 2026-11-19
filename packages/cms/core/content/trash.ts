import "server-only";
import type { Transaction } from "kysely";
import type { TrashedRecord } from "../../generated/client-sqlite";
import { holdsRecordPermission, holdsRecordPermissionForSome } from "../authz/permissions";
import type { Principal } from "../authz/principal";
import { loadAuthSettings } from "../auth/settings";
import { valueSummary } from "../fields/registry";
import { notFound } from "../http/errors";
import { labelIn } from "../i18n/labels";
import prisma from "../../lib/prisma";
import { currentScopeValue } from "../scope/context";
import type { CollectionWithFields } from "./access";
import { allCollections, requireCollection } from "./access";
import { parseId } from "./ids";
import { authorNames } from "./revisions";

/**
 * The trash. A deleted record is kept as a snapshot it can be rebuilt from, so a delete
 * is not the end of the record: `record:delete` for the collection also covers putting it
 * back, since whoever could delete it could already have kept it. Housekeeping removes
 * entries past their retention (Settings → Security → Trash), and a collection's deletion takes its
 * entries with it. History and any pending draft are not kept: a restore brings back the
 * record as it was live.
 */

type Trx = Transaction<Record<string, Record<string, unknown>>>;

/** Values are keyed by field id, as a revision's are, so renaming a field doesn't orphan them. */
export interface TrashedValues {
  [fieldId: string]: unknown;
}

export interface TrashedTranslation {
  locale: string;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedById: string | null;
  source: unknown;
  values: TrashedValues;
}

/** A reference field in another record that named this one, and was cleared by the delete. */
export interface TrashedInboundLink {
  collectionId: number;
  recordId: number;
  fieldId: number;
  /** A field holding several references, where the id is one entry of a JSON list. */
  list: boolean;
}

/** Everything a restore needs. `version` is here so an older entry can be read or refused later. */
export interface TrashSnapshot {
  version: 1;
  values: TrashedValues;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  createdById: string | null;
  translations?: TrashedTranslation[];
  inbound?: TrashedInboundLink[];
  /** The record had more inbound links than one entry remembers, so not all of them come back. */
  inboundLimited?: boolean;
}

export const snapshotOf = (entry: TrashedRecord) => entry.snapshot as unknown as TrashSnapshot;

export interface TrashSettings {
  enabled: boolean;
  retentionDays: number;
}

export async function trashSettings(): Promise<TrashSettings> {
  const { settings } = await loadAuthSettings();
  return settings.trash;
}

/** When an entry made now may be removed for good. */
export const trashExpiry = (retentionDays: number, from = Date.now()) => new Date(from + retentionDays * 86_400_000);

/**
 * The record's one-line summary, as the grid shows it, so the trash list reads without
 * rebuilding every record. Hidden fields are left out: the list is shown to anyone who
 * may delete in the collection, which doesn't by itself include reading hidden values.
 */
export function trashLabel(collection: CollectionWithFields, row: Record<string, unknown>) {
  for (const field of collection.fields) {
    if ((field.config as { hidden?: boolean } | null)?.hidden === true) continue;
    const value = row[field.name];
    const text = (valueSummary(field, value) ?? (field.type === "text" && typeof value === "string" ? value.slice(0, 120) : undefined))?.trim();
    if (text) return text.slice(0, 200);
  }
  return "";
}

/**
 * Written inside the delete's own transaction, so a record is never gone without its entry,
 * and the files it used are held by `TrashedFile` rows, which the library checks before
 * deleting a file. One entry per record: re-deleting a restored record replaces the old one.
 */
export async function writeTrashEntry(trx: Trx, input: {
  collection: CollectionWithFields;
  recordId: number;
  label: string;
  status: string;
  snapshot: TrashSnapshot;
  fileIds: string[];
  createdById: string | null;
  deletedById: string | null;
  retentionDays: number;
  scope: string;
}) {
  const { collection, recordId } = input;
  await trx.deleteFrom("TrashedRecord").where("collectionId", "=", collection.id).where("recordId", "=", recordId).execute();
  const entry = await trx.insertInto("TrashedRecord").values({
    scope: input.scope,
    collectionId: collection.id,
    recordId,
    label: input.label,
    status: input.status,
    snapshot: JSON.stringify(input.snapshot),
    createdById: input.createdById,
    deletedById: input.deletedById,
    deletedAt: new Date().toISOString(),
    expiresAt: trashExpiry(input.retentionDays).toISOString(),
  }).returning("id").executeTakeFirstOrThrow();
  const ids = [...new Set(input.fileIds)];
  if (ids.length) {
    await trx.insertInto("TrashedFile").values(ids.map((fileId) => ({ trashedId: entry.id as number, fileId }))).execute();
  }
  return entry.id as number;
}

/** Entries belong to the scope value their record did, as redirects and audit entries do. */
const scopeWhere = () => {
  const value = currentScopeValue();
  return value === null ? {} : { scope: value };
};

export async function requireTrashEntry(id: number) {
  const entry = await prisma.trashedRecord.findFirst({ where: { id, ...scopeWhere() } });
  if (!entry) throw notFound("Trashed record");
  return entry;
}

export interface TrashItem {
  id: number;
  collectionId: number;
  collection: string;
  recordId: number;
  label: string;
  status: string;
  deletedBy: string | null;
  deletedAt: string;
  expiresAt: string;
  /** Whether this caller may put it back, which also needs the collection to still accept writes. */
  canRestore: boolean;
}

/**
 * The trash a caller may see: entries in collections where they hold `record:delete`, for the
 * collection or over their own records, and for an own grant only the records they created.
 * A collection that has since been deleted has no entries left, so nothing is listed for it.
 */
export async function listTrash(principal: Principal, uiLocale: string, page: number, perPage: number): Promise<{ page: number; perPage: number; totalItems: number; items: TrashItem[] }> {
  const userId = principal.kind === "anonymous" ? null : principal.user.id;
  const collections = (await allCollections()).filter((collection) => holdsRecordPermissionForSome(principal.permissions, "record:delete", collection.id));
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  const full = collections.filter((collection) => holdsRecordPermission(principal.permissions, "record:delete", collection.id)).map((collection) => collection.id);
  const own = collections.filter((collection) => !full.includes(collection.id)).map((collection) => collection.id);
  if (!full.length && !(own.length && userId)) return { page, perPage, totalItems: 0, items: [] };

  // An own grant covers only the records the holder created, as it does everywhere else.
  const reach = [
    ...(full.length ? [{ collectionId: { in: full } }] : []),
    ...(own.length && userId ? [{ collectionId: { in: own }, createdById: userId }] : []),
  ];
  const where = { ...scopeWhere(), OR: reach };
  const [totalItems, entries] = await Promise.all([
    prisma.trashedRecord.count({ where }),
    prisma.trashedRecord.findMany({ where, orderBy: [{ deletedAt: "desc" }, { id: "desc" }], skip: (page - 1) * perPage, take: perPage }),
  ]);
  const names = await authorNames(entries.map((entry) => ({ createdById: entry.deletedById })));
  return {
    page,
    perPage,
    totalItems,
    items: entries.map((entry) => {
      const collection = byId.get(entry.collectionId)!;
      return {
        id: entry.id,
        collectionId: entry.collectionId,
        collection: labelIn(collection, collection.name, uiLocale),
        recordId: entry.recordId,
        label: entry.label,
        status: entry.status,
        deletedBy: entry.deletedById ? names.get(entry.deletedById) ?? null : null,
        deletedAt: entry.deletedAt.toISOString(),
        expiresAt: entry.expiresAt.toISOString(),
        canRestore: collection.type !== "view",
      };
    }),
  };
}

/** Removes an entry for good, with the file holds that came with it. The record itself is long gone. */
export const purgeTrashEntry = (id: number) => prisma.trashedRecord.delete({ where: { id } });

/** How many trashed records still hold this file, so the library can say why it can't be deleted. */
export const trashedFileHolds = (fileId: string) => prisma.trashedFile.count({ where: { fileId } });

/** Housekeeping: entries past their retention. Runs outside any scope value, over every value's. */
export async function purgeExpiredTrash() {
  const { count } = await prisma.trashedRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

/** A scope value's entries, removed with the rest of its rows when it is purged (core/scope/data.ts). */
export const purgeScopeTrash = (scope: string) => prisma.trashedRecord.deleteMany({ where: { scope } });

/**
 * One entry, for a route acting on a record of one collection. The guard let a full or an own
 * `record:delete` grant through (`scope: "record"`), so whose record it was is decided here, by
 * the creator the entry kept. An entry of another collection, scope value or person is missing.
 */
export async function requireTrashed(params: Record<string, string>, principal: Principal) {
  const collection = await requireCollection(parseId(params.id));
  const entry = await requireTrashEntry(parseId(params.trashId));
  if (entry.collectionId !== collection.id) throw notFound("Trashed record");
  if (!holdsRecordPermission(principal.permissions, "record:delete", collection.id)) {
    const userId = principal.kind === "anonymous" ? null : principal.user.id;
    if (!userId || entry.createdById !== userId) throw notFound("Trashed record");
  }
  return { collection: collection as CollectionWithFields, entry };
}

