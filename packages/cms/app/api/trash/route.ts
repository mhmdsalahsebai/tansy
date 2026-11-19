import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { listTrash } from "../../../core/content/trash";
import { adminLocale } from "../../../core/i18n/admin";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The trash: deleted records a caller may put back, which is the collections where they hold
 * `record:delete`, and with only an own grant the records they created. Each entry shows the
 * record's summary as it was deleted, so nothing is read back out of the snapshot here.
 */
export const GET = route({ access: "permission", permission: "dashboard:access", query }, async ({ query, principal }) =>
  listTrash(principal, await adminLocale(principal.user.id), query.page, query.perPage));
