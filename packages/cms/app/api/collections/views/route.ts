import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { createViewCollection } from "../../../../core/schema/service";
import { SLUG_MAX } from "../../../../core/schema/names";

const body = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.").max(SLUG_MAX),
  description: z.string().trim().max(1000).optional(),
  query: z.string().max(10_000),
});

// A view can read every record table past its rules, so this has its own permission.
export const POST = route(
  { access: "permission", permission: "collection:manage-views", body, audit: "collection.create_view", fresh: true },
  async ({ body, principal, auditTarget }) => {
    const collection = await createViewCollection(body, principal.user.id);
    auditTarget("collection", String(collection.id), { slug: collection.slug, query: body.query });
    return collection;
  },
);
