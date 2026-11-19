import { route } from "../../../../core/authz/guard";
import { allCollections } from "../../../../core/content/access";
import { generateOpenApi } from "../../../../core/schema/describe";

export const GET = route({ access: "permission", permission: "collection:read", apiKey: true }, async ({ principal }) =>
  generateOpenApi(await allCollections(), principal, process.env.BETTER_AUTH_URL ?? ""));
