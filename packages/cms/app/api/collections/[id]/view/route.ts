import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { parseId } from "../../../../../core/content/ids";
import { updateViewCollection } from "../../../../../core/schema/service";

export const PUT = route(
  { access: "permission", permission: "collection:manage-views", body: z.object({ query: z.string().max(10_000) }), audit: "collection.update_view", fresh: true },
  async ({ params, body, principal, auditTarget }) => {
    auditTarget("collection", params.id, { query: body.query });
    return updateViewCollection(parseId(params.id), body.query, principal.user.id);
  },
);
