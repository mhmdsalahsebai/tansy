import { z } from "zod";
import { route } from "../../../../../../../core/authz/guard";
import { requireRecord } from "../../../../../../../core/content/revisions";
import { getReview, submitReview, withdrawReview } from "../../../../../../../core/content/reviews";

const body = z.object({ note: z.string().trim().max(2000).optional() });

export const GET = route({ access: "permission", permission: "record:read", scope: "record", apiKey: true }, async ({ params, principal, request }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  return getReview(collection, item.id);
});

/** Asks a reviewer to publish this record's unpublished changes. */
export const POST = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", apiKey: true, body, audit: "record.review_submit" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    auditTarget("record", String(item.id), { collection: collection.slug });
    return submitReview(collection, item, principal.user.id, body.note);
  },
);

export const DELETE = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", apiKey: true, audit: "record.review_withdraw" },
  async ({ params, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    auditTarget("record", String(item.id), { collection: collection.slug });
    await withdrawReview(collection, item.id);
    return null;
  },
);
