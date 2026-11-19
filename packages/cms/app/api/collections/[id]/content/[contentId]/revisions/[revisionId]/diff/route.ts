import { z } from "zod";
import { route } from "../../../../../../../../../core/authz/guard";
import { diffRevision, requireRecord, requireRevision } from "../../../../../../../../../core/content/revisions";

const query = z.object({ against: z.string().regex(/^(previous|current|\d{1,10})$/).default("previous") });

export const GET = route({ access: "permission", permission: "record:read", scope: "record", apiKey: true, query }, async ({ params, query, principal, request }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  return diffRevision(collection, item, await requireRevision(collection, item.id, params.revisionId), query.against);
});
