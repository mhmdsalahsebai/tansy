import { route } from "../../../../../../../../../core/authz/guard";
import { fileActor } from "../../../../../../../../../core/files/refs";
import { requireRecord, requireRevision, restoreRevision } from "../../../../../../../../../core/content/revisions";
import { presentRecord } from "../../../../../../../../../core/content/records";

export const POST = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", apiKey: true, audit: "record.restore" },
  async ({ params, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    const revision = await requireRevision(collection, item.id, params.revisionId);
    auditTarget("record", String(item.id), { collection: collection.slug, revision: revision.number });
    return presentRecord(collection, await restoreRevision(collection, item, revision, fileActor(principal)), principal);
  },
);
