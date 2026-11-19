import { holdsRecordPermission } from "../authz/permissions";
import { HttpError } from "../http/errors";

/**
 * The publishing rule for collections that require review. Kept free of the database, so the
 * record service can check it inside every write, whatever route or plugin started it.
 */

type Status = string | null | undefined;

/** Whether this caller takes changes live in the collection themselves, rather than submitting them for review. */
export function canPublish(collection: { id: number; reviewRequired?: boolean | null }, permissions: ReadonlySet<string> | undefined) {
  // System writes carry no permissions and aren't limited, as for language rights.
  if (!collection.reviewRequired || !permissions) return true;
  return holdsRecordPermission(permissions, "record:publish", collection.id);
}

export const reviewRequired = () => new HttpError(403, "REVIEW_REQUIRED", "This collection needs a reviewer to publish changes. Submit them for review instead.");

/**
 * Anything that changes what's live needs `record:publish` where review is required: publishing,
 * unpublishing, and any write to a record (or translation) that is published. Drafts don't.
 * It applies to everyone who writes with permissions, members and API keys included, so a
 * collection that requires review can't be published to through its API rules either.
 */
export function assertMayPublish(collection: { id: number; reviewRequired?: boolean | null }, actor: { permissions?: ReadonlySet<string> }, before: Status, after: Status) {
  if (before !== "published" && after !== "published") return;
  if (!canPublish(collection, actor.permissions)) throw reviewRequired();
}
