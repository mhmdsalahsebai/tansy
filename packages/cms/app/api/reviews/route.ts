import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { listReviews } from "../../../core/content/reviews";
import { adminLocale } from "../../../core/i18n/admin";

const query = z.object({ state: z.enum(["pending", "changes"]).default("pending") });

/** The review queue: requests a reviewer may act on, and the caller's own. Each record passes its view rule. */
export const GET = route({ access: "permission", permission: "dashboard:access", query }, async ({ query, principal, request }) =>
  listReviews(principal, request.headers, await adminLocale(principal.user.id), query.state));
