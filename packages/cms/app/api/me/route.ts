import { visibleValues } from "../../../core/auth/user-fields";
import { route } from "../../../core/authz/guard";

export const GET = route({ access: "authenticated" }, async ({ principal }) => ({
  user: principal.user,
  fields: await visibleValues(principal.user.id),
  permissions: [...principal.permissions],
  impersonating: principal.kind === "user" && Boolean(principal.session.impersonatedBy),
}));
