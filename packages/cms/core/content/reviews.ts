import "server-only";
import type { ReviewRequest } from "../../generated/client-sqlite";
import { decideRecord, loadRuleLookups, type RuleRequest } from "../authz/records";
import { holdsRecordPermission, holdsRecordPermissionForSome } from "../authz/permissions";
import type { Principal } from "../authz/principal";
import type { FileActor } from "../files/refs";
import { HttpError } from "../http/errors";
import { labelIn } from "../i18n/labels";
import { isLocalizedCollection } from "../i18n/context";
import { withLocale, writeLocale } from "../i18n/storage";
import prisma from "../../lib/prisma";
import { allCollections, type CollectionWithFields } from "./access";
import { findRecordsById, updateContent } from "./content-service";
import { titleOf } from "./overview";
import { flattenRecord, recordChanged, sameMoment, type RecordRow } from "./records";
import { authorNames, findDraft, publishDraft, scope } from "./revisions";

/**
 * Review: draft → in review → published. Someone without `record:publish` submits a record's
 * unpublished changes, and someone with it approves them, which publishes, or sends them back
 * with a note. The publishing rule itself lives in the record service (`./workflow`), so this
 * only keeps track of who asked and what was said.
 */

export type ReviewState = "pending" | "changes";

const NO_REVIEW = () => new HttpError(409, "NO_PENDING_REVIEW", "Nothing is waiting for review on this record.");

async function present(review: ReviewRequest) {
  const names = await authorNames([{ createdById: review.submittedById }, { createdById: review.reviewedById }]);
  const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null);
  return {
    state: review.state as ReviewState,
    note: review.note,
    submittedBy: nameOf(review.submittedById),
    submittedAt: review.submittedAt,
    reviewNote: review.reviewNote,
    reviewedBy: nameOf(review.reviewedById),
    reviewedAt: review.reviewedAt,
  };
}

const findReview = (collection: CollectionWithFields, recordId: number) =>
  prisma.reviewRequest.findUnique({ where: { collectionId_recordId_locale: scope(collection, recordId) } });

export async function getReview(collection: CollectionWithFields, recordId: number) {
  const review = await findReview(collection, recordId);
  return review ? present(review) : null;
}

/** Unpublished work: a record that isn't live, or pending changes to one that is. */
async function hasUnpublishedChanges(collection: CollectionWithFields, item: RecordRow) {
  return item.status !== "published" || Boolean(await findDraft(collection, item.id));
}

/** Submitting again after changes were asked for starts a fresh review. */
export async function submitReview(collection: CollectionWithFields, item: RecordRow, userId: string, note: string | undefined) {
  if (!collection.reviewRequired) throw new HttpError(409, "REVIEW_NOT_REQUIRED", "This collection doesn't require review. Publish the changes instead.");
  if (!(await hasUnpublishedChanges(collection, item))) throw new HttpError(409, "NOTHING_TO_REVIEW", "There are no unpublished changes to review.");
  const where = scope(collection, item.id);
  const fresh = { state: "pending", submittedById: userId, submittedAt: new Date(), note: note || null, reviewedById: null, reviewedAt: null, reviewNote: null };
  await prisma.reviewRequest.upsert({ where: { collectionId_recordId_locale: where }, create: { ...where, ...fresh }, update: fresh });
  return getReview(collection, item.id);
}

export async function withdrawReview(collection: CollectionWithFields, recordId: number) {
  const { count } = await prisma.reviewRequest.deleteMany({ where: scope(collection, recordId) });
  if (!count) throw NO_REVIEW();
}

/** `expected` is what the reviewer read, so changes saved since then aren't published unseen. */
export async function approveReview(collection: CollectionWithFields, item: RecordRow, actor: FileActor, note: string | undefined, expected: { draftAt?: string | null; updatedAt?: string }) {
  const review = await findReview(collection, item.id);
  if (review?.state !== "pending") throw NO_REVIEW();
  const draft = await findDraft(collection, item.id);
  if (expected.updatedAt && !sameMoment(item.updatedAt, expected.updatedAt)) throw recordChanged();
  if (expected.draftAt !== undefined) {
    const unchanged = draft && expected.draftAt ? sameMoment(draft.createdAt, expected.draftAt) : !draft && !expected.draftAt;
    if (!unchanged) throw recordChanged();
  }
  const text = note ? `Approved: ${note}` : "Approved in review";
  // Publishing closes the review in the same transaction, whichever way it goes live.
  if (draft) return publishDraft(collection, item, actor, text);
  return updateContent(collection, item, "published", {}, { ...actor, canUseAny: true }, text, expected.updatedAt);
}

export async function requestChanges(collection: CollectionWithFields, recordId: number, reviewerId: string, note: string) {
  const review = await findReview(collection, recordId);
  if (review?.state !== "pending") throw NO_REVIEW();
  await prisma.reviewRequest.update({ where: { id: review.id }, data: { state: "changes", reviewedById: reviewerId, reviewedAt: new Date(), reviewNote: note } });
  return getReview(collection, recordId);
}

const QUEUE = 200;

/**
 * The review queue. Reviewers see requests in collections where they hold `record:publish`;
 * everyone sees their own submissions. Each record still has to pass its view rule for the
 * caller, as on the dashboard home, so the queue reveals nothing the records API wouldn't.
 */
export async function listReviews(principal: Principal, headers: Headers, uiLocale: string, state: ReviewState) {
  const userId = principal.kind === "anonymous" ? null : principal.user.id;
  const collections = new Map((await allCollections()).map((collection) => [collection.id, collection]));
  const reviews = await prisma.reviewRequest.findMany({ where: { state }, orderBy: { submittedAt: "asc" }, take: QUEUE * 5 });

  const reviewer = (collectionId: number) => holdsRecordPermission(principal.permissions, "record:publish", collectionId);
  const offered = reviews.filter((review) => {
    const collection = collections.get(review.collectionId);
    if (!collection || !holdsRecordPermissionForSome(principal.permissions, "record:read", collection.id)) return false;
    return reviewer(collection.id) || (userId !== null && review.submittedById === userId);
  });

  // Each language reads its own translation, as the editor does.
  const groups = new Map<string, { collection: CollectionWithFields; locale: string; ids: number[] }>();
  for (const review of offered) {
    const key = `${review.collectionId}:${review.locale}`;
    if (!groups.has(key)) {
      const base = collections.get(review.collectionId)!;
      const collection = review.locale && isLocalizedCollection(base) ? withLocale(base, writeLocale(review.locale)) : base;
      groups.set(key, { collection, locale: review.locale, ids: [] });
    }
    groups.get(key)!.ids.push(review.recordId);
  }
  const lookups = await loadRuleLookups([...new Set([...groups.values()].map((group) => group.collection))]);
  const rows = new Map<string, { collection: CollectionWithFields; row: RecordRow }>();
  await Promise.all([...groups].map(async ([key, { collection, locale, ids }]) => {
    const request: RuleRequest = { method: "GET", headers, query: {}, body: {}, lookups, ...(locale ? { locale } : {}) };
    for (const row of await findRecordsById(collection, ids)) {
      if (decideRecord(principal, collection, "view", flattenRecord(row), request) === "allow") rows.set(`${key}:${row.id}`, { collection, row });
    }
  }));

  const shown = offered.flatMap((review) => {
    const found = rows.get(`${review.collectionId}:${review.locale}:${review.recordId}`);
    return found ? [{ review, ...found }] : [];
  }).slice(0, QUEUE);
  const names = await authorNames(shown.flatMap(({ review }) => [{ createdById: review.submittedById }, { createdById: review.reviewedById }]));
  const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null);
  return {
    items: shown.map(({ review, collection, row }) => ({
      collectionId: collection.id,
      collection: labelIn(collection, collection.name, uiLocale),
      recordId: row.id,
      locale: review.locale || null,
      title: titleOf(collection, row, principal),
      status: row.status,
      state: review.state as ReviewState,
      note: review.note,
      submittedBy: nameOf(review.submittedById),
      submittedAt: review.submittedAt,
      reviewNote: review.reviewNote,
      reviewedBy: nameOf(review.reviewedById),
      reviewedAt: review.reviewedAt,
      mine: userId !== null && review.submittedById === userId,
      canReview: reviewer(collection.id),
    })),
  };
}
