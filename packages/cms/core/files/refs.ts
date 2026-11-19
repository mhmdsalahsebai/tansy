import "server-only";
import type { Transaction } from "kysely";
import type { Principal } from "../authz/principal";
import { loadBlockCatalog } from "../blocks/service";
import { streamFiles, type Block } from "../blocks/stream";
import { chunks } from "../content/chunks";
import { forKeyShare } from "../content/locks";
import type { CollectionWithFields } from "../content/access";
import { fieldStorage, hasValueRefs, valueRefs } from "../fields/registry";
import type { FieldLike } from "../fields/validate";
import { HttpError } from "../http/errors";
import { refLocale } from "../i18n/context";
import { SCOPE_COLUMN, currentScope } from "../scope/context";
import { scopedCollectionIds } from "../scope/registry";
import { tableName } from "../schema/names";
import { RASTER_IMAGES, typeAllowed } from "./sniff";

type Trx = Transaction<Record<string, Record<string, unknown>>>;

/** Who is saving, for deciding which existing files they may attach. */
export interface FileActor {
  userId: string | null;
  canUseAny: boolean;
  /** What the writer holds, for hooks' can(). Absent holds nothing. */
  permissions?: ReadonlySet<string>;
}

export const fileActor = (principal: Principal): FileActor => ({
  userId: principal.kind === "anonymous" ? null : principal.user.id,
  canUseAny: principal.permissions.has("file:read"),
  permissions: principal.permissions,
});

interface StoredInfo {
  id: string;
  scope: string;
  type: string;
  size: number;
  createdById: string | null;
}

const invalid = (path: string, message: string) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path, message }]);

function limitProblem(field: FieldLike, file: StoredInfo) {
  const { maxSize, allowedTypes } = (field.config ?? {}) as { maxSize?: number; allowedTypes?: string[] };
  if (field.type === "image" && !allowedTypes?.length && !RASTER_IMAGES.has(file.type)) return "This file is not an image.";
  if (!typeAllowed(file.type, allowedTypes)) return `Files of type ${file.type} are not allowed here.`;
  if (maxSize !== undefined && file.size > maxSize) return "This file is too large for this field.";
  return null;
}

const ownStorage = fieldStorage;

/**
 * The scope value a record belongs to, for deciding which scope's files it may use: the value
 * the work is for on a scoped collection, read from the row itself in trusted work across every
 * value, and the instance's (empty) on any other collection, whose readers span every value.
 * Null when it can't be told, which allows only the instance's files.
 */
async function recordScope(trx: Trx, collection: CollectionWithFields, recordId: number): Promise<string | null> {
  if (!scopedCollectionIds().has(collection.id)) return "";
  const state = currentScope();
  if (state?.kind === "value") return state.value;
  if (state?.kind !== "all") return null;
  const row = await trx.selectFrom(tableName(collection.slug)).select(SCOPE_COLUMN).where("id", "=", recordId).executeTakeFirst();
  const value = row?.[SCOPE_COLUMN];
  return typeof value === "string" ? value : null;
}

function lazy<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= make());
}

/**
 * Everything file-related being saved, after checking each file. A FileRef grants
 * readers of this record access to the file, so a caller may only attach a file
 * they already have a claim to: otherwise anyone who learned an id could attach
 * it to their own public record and read it.
 */
async function resolveFileUses(trx: Trx, collection: CollectionWithFields, recordId: number, values: Record<string, unknown>, actor: FileActor, locale?: string) {
  const fields = collection.fields.filter((field) => field.name in values && (field.type === "stream" || ownStorage(field).files || hasValueRefs(field.type)));
  if (!fields.length) return { fields, kept: new Map<number, string[]>(), rows: [] };

  const catalog = fields.some((field) => field.type === "stream") ? await loadBlockCatalog() : null;
  const before = await trx.selectFrom("FileRef").select(["fileId", "fieldId"]).where("sourceCollectionId", "=", collection.id).where("sourceRecordId", "=", recordId).execute();
  const onRecord = new Set(before.map((ref) => ref.fileId as string));
  const onField = new Set(before.map((ref) => `${ref.fieldId as number}:${ref.fileId as string}`));

  const kept = new Map<number, string[]>();
  const uses: Array<{ owner: (typeof fields)[number]; rules: FieldLike; blockId: string; fileId: string }> = [];
  for (const field of fields) {
    if (field.type === "stream") {
      const { files, opaque } = streamFiles((values[field.name] ?? []) as Block[], catalog!);
      kept.set(field.id, [...opaque]);
      for (const { blockId, field: rules, fileIds } of files) uses.push(...fileIds.map((fileId) => ({ owner: field, rules, blockId, fileId })));
    } else {
      const ids = ownStorage(field).files ? [values[field.name]].flat().filter((id): id is string => typeof id === "string" && id !== "") : [];
      uses.push(...[...ids, ...valueRefs(field, values[field.name]).files].map((fileId) => ({ owner: field, rules: field, blockId: "", fileId })));
    }
  }

  const found = new Map<string, StoredInfo>();
  for (const part of chunks([...new Set(uses.map((use) => use.fileId))])) {
    // Held until commit, so the file can't be deleted while this save attaches it.
    const stored = await forKeyShare(trx.selectFrom("StoredFile").select(["id", "scope", "type", "size", "createdById"]).where("id", "in", part)).execute();
    for (const row of stored) found.set(row.id as string, row as unknown as StoredInfo);
  }

  // A record uses the instance's files and its own scope value's, never another value's, whose
  // readers couldn't open it. Asked only when a file belongs to a value.
  const recordScopeOnce = lazy(() => recordScope(trx, collection, recordId));
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const { owner, rules, blockId, fileId } of uses) {
    const file = found.get(fileId);
    const isUploader = actor.userId !== null && file?.createdById === actor.userId;
    const inScope = file !== undefined && (file.scope === "" || file.scope === (await recordScopeOnce()));
    // The same answer whether the file is missing or off limits, so this can't probe for ids.
    if (!file || !inScope || !(actor.canUseAny || isUploader || onRecord.has(fileId))) throw invalid(owner.name, "This file does not exist.");
    // Files already here stay, even if the field's limits have since tightened.
    if (!onField.has(`${owner.id}:${fileId}`)) {
      const problem = limitProblem(rules, file);
      if (problem) throw invalid(owner.name, problem);
    }
    const key = `${owner.id}:${blockId}:${fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ fileId, sourceCollectionId: collection.id, sourceRecordId: recordId, fieldId: owner.id, blockId, locale: refLocale(collection, owner, locale) });
  }
  return { fields, kept, rows };
}

/** The same checks as saving, for content that isn't going live yet. */
export async function assertFilesAttachable(trx: Trx, collection: CollectionWithFields, recordId: number, values: Record<string, unknown>, actor: FileActor, locale?: string) {
  await resolveFileUses(trx, collection, recordId, values, actor, locale);
}

/** Keeps FileRef in step with the file and stream fields just written, in the write transaction. */
/** `locale` is the language written, for a localized collection. A localized field's files belong to that language alone. */
export async function syncFileRefs(trx: Trx, collection: CollectionWithFields, recordId: number, values: Record<string, unknown>, actor: FileActor, locale?: string) {
  const { fields, kept, rows } = await resolveFileUses(trx, collection, recordId, values, actor, locale);
  for (const field of fields) {
    let stale = trx.deleteFrom("FileRef").where("fieldId", "=", field.id).where("sourceRecordId", "=", recordId).where("locale", "=", refLocale(collection, field, locale));
    for (const part of chunks(kept.get(field.id) ?? [])) stale = stale.where("blockId", "not in", part);
    await stale.execute();
  }
  for (const part of chunks(rows)) await trx.insertInto("FileRef").values(part).execute();
}
