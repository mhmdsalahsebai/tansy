import { route } from "../../../../core/authz/guard";
import { listBlockTypes } from "../../../../core/blocks/service";
import { allCollections } from "../../../../core/content/access";
import { generateTypes } from "../../../../core/schema/describe";

export const GET = route({ access: "permission", permission: "collection:read", apiKey: true }, async ({ principal }) =>
  new Response(generateTypes(await allCollections(), principal, await listBlockTypes()), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }));
