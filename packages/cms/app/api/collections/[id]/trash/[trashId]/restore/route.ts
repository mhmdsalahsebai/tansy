import { route } from "../../../../../../../core/authz/guard";
import { presentRecord } from "../../../../../../../core/content/records";
import { restoreFromTrash } from "../../../../../../../core/content/content-service";
import { requireTrashed } from "../../../../../../../core/content/trash";
import { fileActor } from "../../../../../../../core/files/refs";

/**
 * Puts a deleted record back under its own id. It is validated as a new record is, and a record
 * that comes back published needs `record:publish` where the collection requires review.
 */
export const POST = route(
  { access: "permission", permission: "record:delete", scope: "record", audit: "record.restore" },
  async ({ params, principal, auditTarget }) => {
    const { collection, entry } = await requireTrashed(params, principal);
    auditTarget("record", String(entry.recordId), { collection: collection.slug, trashed: entry.id });
    return presentRecord(collection, await restoreFromTrash(collection, entry, fileActor(principal)), principal);
  },
);
