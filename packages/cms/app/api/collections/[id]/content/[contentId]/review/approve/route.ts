import { z } from "zod";
import { route } from "../../../../../../../../core/authz/guard";
import { presentRecord, versionStamp } from "../../../../../../../../core/content/records";
import { requireRecord } from "../../../../../../../../core/content/revisions";
import { approveReview } from "../../../../../../../../core/content/reviews";
import { fileActor } from "../../../../../../../../core/files/refs";

const body = z.object({
  note: z.string().trim().max(2000).optional(),
  /** The live record the reviewer read. */
  expectedUpdatedAt: versionStamp.optional(),
  /** The pending changes the reviewer read, or null when there were none. */
  expectedDraftAt: versionStamp.nullable().optional(),
});

/** Publishes the changes under review. The record service checks `record:publish` again as it writes. */
export const POST = route(
  { access: "permission", permission: ["record:read", "record:update", "record:publish"], scope: "record", apiKey: true, body, audit: "record.review_approve" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    auditTarget("record", String(item.id), { collection: collection.slug });
    const updated = await approveReview(collection, item, fileActor(principal), body.note, { updatedAt: body.expectedUpdatedAt, draftAt: body.expectedDraftAt });
    return presentRecord(collection, updated, principal);
  },
);
