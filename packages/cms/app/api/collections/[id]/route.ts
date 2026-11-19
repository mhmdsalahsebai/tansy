import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { deleteCollections, getCollection, updateCollection } from "../../../../core/content/collections";
import { parseId } from "../../../../core/content/ids";
import { SLUG_MAX } from "../../../../core/schema/names";
import { labelsSchema } from "../../../../core/i18n/labels-schema";

export const GET = route({ access: "permission", permission: "collection:read", apiKey: true }, ({ params }) => getCollection(parseId(params.id)));

const body = z.object({ name: z.string().trim().min(1).max(120).optional(), labels: labelsSchema(120).nullable().optional(), slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.").max(SLUG_MAX).optional(), description: z.string().trim().max(1000).optional(), urlPattern: z.string().trim().min(1).max(2048).nullable().optional(), reviewRequired: z.boolean().optional() });

export const PATCH = route(
  { access: "permission", permission: "collection:update", body, audit: "collection.update" },
  async ({ params, body, principal, auditTarget }) => {
    auditTarget("collection", params.id);
    return updateCollection(parseId(params.id), body, principal.user.id);
  },
);

export const DELETE = route(
  { access: "permission", permission: "collection:delete", audit: "collection.delete", fresh: true },
  async ({ params, principal, auditTarget }) => {
    auditTarget("collection", params.id);
    await deleteCollections([parseId(params.id)], principal.user.id);
    return null;
  },
);
