import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { parseId } from "../../../../../core/content/ids";
import { updateCollectionScope } from "../../../../../core/schema/service";

const body = z.object({ scoped: z.boolean() });

/**
 * Turns row scopes on or off for a collection (core/scope). Turning them on moves every existing
 * record to the provider's first value. Turning them off is refused while records belong to more
 * than one value, so two scopes' records are never merged.
 */
export const PUT = route(
  { access: "permission", permission: "collection:update", body, audit: "collection.update_scope", fresh: true },
  async ({ params, body, principal, auditTarget }) => {
    const collection = await updateCollectionScope(parseId(params.id), body.scoped, principal.user.id);
    auditTarget("collection", params.id, { scoped: collection.scoped });
    return collection;
  },
);
