import { z } from "zod";
import { route } from "../../../../../../../core/authz/guard";
import { listRevisions, requireRecord } from "../../../../../../../core/content/revisions";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
});

// Snapshots include hidden fields, so these are for staff with record:read, never for API rules.
export const GET = route({ access: "permission", permission: "record:read", scope: "record", apiKey: true, query }, async ({ params, query, principal, request }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  return listRevisions(collection, item.id, query.page, query.perPage);
});
