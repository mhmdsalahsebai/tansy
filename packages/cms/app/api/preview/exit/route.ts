import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { clearPreviewCookie } from "../../../../core/site/preview";
import { BASE_PATH } from "../../../../core/urls/base-path";

/** The site to go back to: a scope value's path prefix, such as "/acme". One segment, so it can only name a site on this instance. */
const query = z.object({ to: z.string().regex(BASE_PATH).optional() });

export const GET = route({ access: "public", reason: "Only clears the visitor's own preview cookie. It reads nothing and can only take access away.", query }, async ({ query }) => (
  new Response(null, { status: 307, headers: { location: query.to ?? "/", "set-cookie": clearPreviewCookie(), "cache-control": "no-store" } })
));
