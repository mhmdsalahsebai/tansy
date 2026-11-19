import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { getCollection, updateFields } from "../../../../../core/content/collections";
import { reindexCollection } from "../../../../../core/content/content-service";
import { searchSignature } from "../../../../../core/search/extract";
import { parseId } from "../../../../../core/content/ids";

const body = z.object({
  fields: z.array(z.object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120),
    type: z.string().min(1).max(40),
    config: z.record(z.string(), z.unknown()).optional(),
  })).max(200),
  confirm: z.boolean().default(false),
});

export const PUT = route(
  { access: "permission", permission: "collection:update", body, audit: "collection.update_fields", fresh: true },
  async ({ params, body, principal, auditTarget }) => {
    const before = searchSignature((await getCollection(parseId(params.id))).fields);
    const { collection, summary } = await updateFields(parseId(params.id), body.fields, body.confirm, principal.user.id);
    auditTarget("collection", params.id, summary);
    if (searchSignature(collection.fields) !== before) void reindexCollection(collection).catch((error) => console.error("[search] reindex failed", error));
    return collection;
  },
);
