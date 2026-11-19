import { route } from "../../../../../../../core/authz/guard";
import { requireRecord } from "../../../../../../../core/content/revisions";
import { createPreviewToken, previewEntryUrl } from "../../../../../../../core/site/preview";

/**
 * A link that shows one record's unpublished state. It needs `record:read` like the rest
 * of a record's history, and the token keeps working only while its maker holds that.
 */
export const POST = route({ access: "permission", permission: "record:read", scope: "record", audit: "record.preview" }, async ({ params, principal, request, auditTarget }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  auditTarget("record", `${collection.slug}/${item.id}`);
  const { token, expiresAt } = createPreviewToken(collection.id, item.id, principal.user.id);
  return { token, expiresAt, url: previewEntryUrl(token) };
});
