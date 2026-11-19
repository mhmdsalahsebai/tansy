import { route } from "../../../../core/authz/guard";
import { exportSchema } from "../../../../core/schema/portable";

export const GET = route({ access: "permission", permission: "collection:read" }, async ({ principal }) => exportSchema({ userFields: principal.permissions.has("user:get") }));
