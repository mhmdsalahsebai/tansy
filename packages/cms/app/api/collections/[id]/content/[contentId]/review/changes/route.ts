import { z } from "zod";
import { route } from "../../../../../../../../core/authz/guard";
import { requireRecord } from "../../../../../../../../core/content/revisions";
import { requestChanges } from "../../../../../../../../core/content/reviews";

const body = z.object({ note: z.string().trim().min(1).max(2000) });

/** Sends the changes back to their author with a note. Nothing is published or discarded. */
export const POST = route(
  { access: "permission", permission: ["record:read", "record:publish"], scope: "record", apiKey: true, body, audit: "record.review_changes" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "view");
    auditTarget("record", String(item.id), { collection: collection.slug });
    return requestChanges(collection, item.id, principal.user.id, body.note);
  },
);
