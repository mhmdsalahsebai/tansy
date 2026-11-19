import { route } from "../../../../../../../../core/authz/guard";
import { fileActor } from "../../../../../../../../core/files/refs";
import { presentRecord } from "../../../../../../../../core/content/records";
import { publishDraft, requireRecord } from "../../../../../../../../core/content/revisions";

export const POST = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", apiKey: true, audit: "record.draft_publish" },
  async ({ params, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    auditTarget("record", String(item.id), { collection: collection.slug });
    return presentRecord(collection, await publishDraft(collection, item, fileActor(principal)), principal);
  },
);
