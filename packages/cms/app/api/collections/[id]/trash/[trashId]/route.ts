import { route } from "../../../../../../core/authz/guard";
import { purgeTrashEntry, requireTrashed } from "../../../../../../core/content/trash";

/** Removes one entry for good. The record itself went when it was deleted. */
export const DELETE = route(
  { access: "permission", permission: "record:delete", scope: "record", audit: "record.purge" },
  async ({ params, principal, auditTarget }) => {
    const { collection, entry } = await requireTrashed(params, principal);
    auditTarget("record", String(entry.recordId), { collection: collection.slug, trashed: entry.id });
    await purgeTrashEntry(entry.id);
    return null;
  },
);
