import "server-only";
import type { NextRequest } from "next/server";
import type { Revision } from "../../generated/client-sqlite";
import { authorizeRecord, loadRuleLookups } from "../authz/records";
import type { Principal } from "../authz/principal";
import { validateRecordValues } from "../blocks/service";
import { assertFilesAttachable, type FileActor } from "../files/refs";
import type { HookActor } from "../extend/hooks";
import { HttpError, notFound } from "../http/errors";
import prisma from "../../lib/prisma";
import { requireCollection, ruleRequest, type CollectionWithFields } from "./access";
import { assertWritable, requireContent, updateContent } from "./content-service";
import { tableName } from "../schema/names";
import { recordsDb } from "./db";
import { forUpdate } from "./locks";
import { diffValues } from "./diff";
import { parseId } from "./ids";
import { flattenRecord, recordChanged, resolveValues, sameMoment, type ContentInput, type RecordRow } from "./records";
import { byFieldId } from "./revision-store";
import { isLocalizedCollection } from "../i18n/context";
import { localeParams, writingLocale } from "../i18n/request";
import { localeTableName } from "../schema/names";
import { assertLocaleWritable } from "../i18n/permissions";
import { defaultLocale } from "../i18n/locales";
import { splitValues } from "../i18n/storage";

/** Every revision, draft and schedule route enters here, so record access rules always apply. */
/** A localized record's history, draft and schedule belong to one language, named by `?locale=`, the default otherwise. */
export async function requireRecord(params: Record<string, string>, principal: Principal, request: NextRequest, action: "view" | "update") {
  const { collection, locale } = await writingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
  if (action === "update") assertWritable(collection);
  // Drafts, schedules and restores change one language, so they need the right to edit it.
  if (action === "update" && locale) assertLocaleWritable(collection, principal, locale, false, await defaultLocale());
  const item = await requireContent(collection, parseId(params.contentId));
  authorizeRecord(principal, collection, action, flattenRecord(item), { ...ruleRequest(request, {}, {}, await loadRuleLookups([collection])), locale });
  return { collection, item };
}

/** The language a revision, draft or schedule belongs to. Empty for a collection with one language. */
const localeKey = (collection: CollectionWithFields) => (isLocalizedCollection(collection) ? collection.locale?.code ?? "" : "");

type StoredValues = Record<string, unknown>;
const storedValues = (revision: Revision) => revision.values as StoredValues;

const asNames = (collection: CollectionWithFields, stored: StoredValues) =>
  Object.fromEntries(collection.fields.filter((field) => Object.hasOwn(stored, field.id)).map((field) => [field.name, stored[field.id]]));

const listed = (collection: CollectionWithFields, stored: StoredValues) =>
  collection.fields.filter((field) => Object.hasOwn(stored, field.id)).map((field) => ({ fieldId: field.id, value: stored[field.id] }));

/**
 * Saved content goes live through the normal write path. Passing it as its own
 * "existing" values lets blocks that were valid when saved stay as they are.
 * The file check was made when the content was first saved, and whoever acts
 * now may be someone else, so it isn't repeated here.
 */
async function applyStored(collection: CollectionWithFields, item: RecordRow, stored: StoredValues, status: "draft" | "published" | undefined, actor: HookActor, note: string) {
  const named = asNames(collection, stored);
  const values = await validateRecordValues(collection.fields, named, named);
  return updateContent(collection, item, status, values, { ...actor, canUseAny: true }, note);
}

export async function authorNames(revisions: Array<Pick<Revision, "createdById">>) {
  const ids = [...new Set(revisions.flatMap((revision) => (revision.createdById ? [revision.createdById] : [])))];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((user) => [user.id, user.name]));
}

const summary = (revision: Revision, names: Map<string, string>) => ({
  id: revision.id,
  number: revision.number,
  status: revision.status,
  note: revision.note,
  author: revision.createdById ? (names.get(revision.createdById) ?? null) : null,
  createdAt: revision.createdAt,
});

export const scope = (collection: CollectionWithFields, recordId: number) => ({ collectionId: collection.id, recordId, locale: localeKey(collection) });

export async function listRevisions(collection: CollectionWithFields, recordId: number, page: number, perPage: number) {
  const where = { ...scope(collection, recordId), kind: "history" };
  const [totalItems, revisions] = await Promise.all([
    prisma.revision.count({ where }),
    prisma.revision.findMany({ where, orderBy: { number: "desc" }, skip: (page - 1) * perPage, take: perPage }),
  ]);
  const names = await authorNames(revisions);
  return { page, perPage, totalItems, items: revisions.map((revision) => summary(revision, names)) };
}

export async function requireRevision(collection: CollectionWithFields, recordId: number, rawId: string) {
  const revision = await prisma.revision.findFirst({ where: { id: parseId(rawId), kind: "history", ...scope(collection, recordId) } });
  if (!revision) throw notFound("Revision");
  return revision;
}

export async function presentRevision(collection: CollectionWithFields, revision: Revision) {
  return { ...summary(revision, await authorNames([revision])), values: listed(collection, storedValues(revision)) };
}

/** `against` is "previous", "current" (the live record) or another revision's id. */
export async function diffRevision(collection: CollectionWithFields, item: RecordRow, revision: Revision, against: string) {
  let base: StoredValues | null;
  let baseLabel: number | "current" | null;
  if (against === "current") {
    base = JSON.parse(JSON.stringify(byFieldId(collection, item)));
    baseLabel = "current";
  } else {
    const other = against === "previous"
      ? await prisma.revision.findFirst({ where: { ...scope(collection, item.id), kind: "history", number: { lt: revision.number } }, orderBy: { number: "desc" } })
      : await requireRevision(collection, item.id, against);
    base = other ? storedValues(other) : null;
    baseLabel = other?.number ?? null;
  }
  return { number: revision.number, against: baseLabel, changes: diffValues(collection.fields, base, storedValues(revision)) };
}

/** Puts an old revision's values back as a new revision, so a restore can be undone too. Status stays as it is. */
export function restoreRevision(collection: CollectionWithFields, item: RecordRow, revision: Revision, actor: HookActor) {
  return applyStored(collection, item, storedValues(revision), undefined, actor, `Restored revision ${revision.number}`);
}

export const findDraft = (collection: CollectionWithFields, recordId: number) => prisma.revision.findFirst({ where: { ...scope(collection, recordId), kind: "draft" } });

/** A pending draft's values by field name, to lay over the live row. Empty when there is none. */
export async function findDraftValues(collection: CollectionWithFields, recordId: number) {
  const draft = await findDraft(collection, recordId);
  return draft ? asNames(collection, storedValues(draft)) : {};
}

/** A record or null, where requireContent would throw. */
export const findRow = (collection: CollectionWithFields, id: number) => requireContent(collection, id).catch((error) => {
  if (error instanceof HttpError && error.status === 404) return null;
  throw error;
});

export async function getDraft(collection: CollectionWithFields, recordId: number) {
  const draft = await findDraft(collection, recordId);
  if (!draft) return null;
  return { ...summary(draft, await authorNames([draft])), values: listed(collection, storedValues(draft)) };
}

/** Pending changes to a published record. The live row isn't touched, so public reads and rules see nothing new. */
export async function saveDraft(collection: CollectionWithFields, item: RecordRow, input: ContentInput, actor: FileActor, expected: { updatedAt?: string; draftAt?: string | null } = {}) {
  if (item.status !== "published") throw new HttpError(409, "NOT_PUBLISHED", "This record isn't published, so save it directly.");
  const submitted = resolveValues(collection, input);
  // As for a save: values shared by every language need the right to edit the default one.
  if (isLocalizedCollection(collection) && collection.locale) assertLocaleWritable(collection, actor, collection.locale.code, Object.keys(splitValues(collection, submitted).shared).length > 0, await defaultLocale());
  const clean = await validateRecordValues(collection.fields, submitted, item);
  await recordsDb.transaction().execute(async (trx) => {
    // One draft per record, so two saves of the same record take turns.
    const live = await forUpdate(trx.selectFrom(tableName(collection.slug)).select(["id", "updatedAt"]).where("id", "=", item.id)).executeTakeFirst();
    const locale = localeKey(collection);
    // A translation has its own updatedAt.
    const stamp = locale ? (await trx.selectFrom(localeTableName(collection.slug)).select("updatedAt").where("recordId", "=", item.id).where("locale", "=", locale).executeTakeFirst())?.updatedAt : live?.updatedAt;
    if (expected.updatedAt && live && !sameMoment(stamp, expected.updatedAt)) throw recordChanged();
    if (expected.draftAt !== undefined) {
      const draft = await trx.selectFrom("Revision").select("createdAt").where("collectionId", "=", collection.id).where("recordId", "=", item.id).where("locale", "=", locale).where("kind", "=", "draft").executeTakeFirst();
      const unchanged = draft && expected.draftAt ? sameMoment(draft.createdAt, expected.draftAt) : !draft && !expected.draftAt;
      if (!unchanged) throw recordChanged();
    }
    await trx.deleteFrom("Revision").where("collectionId", "=", collection.id).where("recordId", "=", item.id).where("locale", "=", locale).where("kind", "=", "draft").execute();
    await assertFilesAttachable(trx, collection, item.id, clean, actor, locale || undefined);
    await trx.insertInto("Revision").values({
      collectionId: collection.id, recordId: item.id, locale, kind: "draft", number: 0, status: "draft",
      values: JSON.stringify(byFieldId(collection, clean)), createdById: actor.userId, createdAt: new Date().toISOString(),
    }).execute();
  });
}

/** A review of a published record covers its draft, so discarding the draft withdraws the review too. */
export async function discardDraft(collection: CollectionWithFields, recordId: number) {
  await prisma.$transaction([
    prisma.revision.deleteMany({ where: { ...scope(collection, recordId), kind: "draft" } }),
    prisma.reviewRequest.deleteMany({ where: scope(collection, recordId) }),
  ]);
}

export async function publishDraft(collection: CollectionWithFields, item: RecordRow, actor: HookActor, note = "Published draft") {
  const draft = await findDraft(collection, item.id);
  if (!draft) throw notFound("Draft");
  const updated = await applyStored(collection, item, storedValues(draft), "published", actor, note);
  await discardDraft(collection, item.id);
  return updated;
}

/** Applies pending changes if there are any, otherwise just publishes. For the scheduler. */
export async function publishLatest(collection: CollectionWithFields, item: RecordRow, actor: HookActor) {
  if (await findDraft(collection, item.id)) return publishDraft(collection, item, actor);
  return updateContent(collection, item, "published", {}, { ...actor, canUseAny: true }, "Published on schedule");
}

export async function getSchedule(collection: CollectionWithFields, recordId: number) {
  const actions = await prisma.scheduledAction.findMany({ where: scope(collection, recordId) });
  const view = (action: string) => {
    const found = actions.find((candidate) => candidate.action === action);
    return found ? { at: found.at, failedAt: found.failedAt, error: found.error } : null;
  };
  return { publish: view("publish"), unpublish: view("unpublish") };
}

/** Replaces the whole schedule. A null time clears that action. */
export async function setSchedule(collection: CollectionWithFields, recordId: number, { publishAt, unpublishAt }: { publishAt: string | null; unpublishAt: string | null }, createdById: string) {
  const [publish, unpublish] = [publishAt ? new Date(publishAt) : null, unpublishAt ? new Date(unpublishAt) : null];
  const issues = [
    ...(publish && publish <= new Date() ? [{ path: "publishAt", message: "Choose a time in the future." }] : []),
    ...(unpublish && unpublish <= new Date() ? [{ path: "unpublishAt", message: "Choose a time in the future." }] : []),
    ...(publish && unpublish && unpublish <= publish ? [{ path: "unpublishAt", message: "Must be after the publish time." }] : []),
  ];
  if (issues.length) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", issues);

  const planned = [{ action: "publish", at: publish }, { action: "unpublish", at: unpublish }].flatMap(({ action, at }) => (at ? [{ ...scope(collection, recordId), action, at, createdById }] : []));
  await prisma.$transaction([prisma.scheduledAction.deleteMany({ where: scope(collection, recordId) }), prisma.scheduledAction.createMany({ data: planned })]);
}
