import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { createCollection, deleteCollections, listCollections } from "../../../core/content/collections";
import { scopesNewCollections } from "../../../core/scope/provider";
import { SLUG_MAX } from "../../../core/schema/names";
import { labelsSchema } from "../../../core/i18n/labels-schema";

export const GET = route({ access: "permission", permission: "collection:read", apiKey: true }, () => listCollections());

const body = z.object({
  name: z.string().trim().min(1).max(120),
  /** The name in other interface languages, such as { "ar": "المقالات" }. */
  labels: labelsSchema(120).nullable().optional(),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.").max(SLUG_MAX),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(["base", "singleton"]).default("base"),
  urlPattern: z.string().trim().min(1).max(2048).nullable().optional(),
  fields: z.array(z.object({ name: z.string().trim().min(1).max(120), type: z.string().min(1).max(40), config: z.record(z.string(), z.unknown()).optional() })).max(200),
  /** Start with localization on: fields marked `localized` hold a value per language. */
  localization: z.object({ enabled: z.boolean(), fallback: z.enum(["chain", "none"]).optional(), fieldFallback: z.boolean().optional() }).nullable().optional(),
  /** Split by the scope provider's value. Defaults to the provider's choice, and is refused without a provider. */
  scoped: z.boolean().optional(),
});

export const POST = route(
  { access: "permission", permission: "collection:create", body, audit: "collection.create" },
  async ({ body, principal, auditTarget }) => {
    const collection = await createCollection({ ...body, scoped: body.scoped ?? scopesNewCollections() }, principal.user.id);
    auditTarget("collection", String(collection.id), { slug: collection.slug });
    return collection;
  },
);

export const DELETE = route(
  { access: "permission", permission: "collection:delete", body: z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(200) }), audit: "collection.bulk_delete" },
  async ({ body, principal, auditTarget }) => {
    auditTarget("collection", body.ids.join(","));
    await deleteCollections(body.ids, principal.user.id);
    return null;
  },
);
