import { route } from "../../../../../../../../core/authz/guard";
import { presentRevision, requireRecord, requireRevision } from "../../../../../../../../core/content/revisions";

export const GET = route({ access: "permission", permission: "record:read", scope: "record", apiKey: true }, async ({ params, principal, request }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  return presentRevision(collection, await requireRevision(collection, item.id, params.revisionId));
});
