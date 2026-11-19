import { route } from "../../../core/authz/guard";
import { fieldCatalogue } from "../../../core/fields/registry";

export const GET = route({ access: "permission", permission: "collection:read" }, async () => fieldCatalogue());
