import { route } from "../../../../core/authz/guard";
import { clearPreviewCookie } from "../../../../core/site/preview";

export const GET = route({ access: "public", reason: "Only clears the visitor's own preview cookie. It reads nothing and can only take access away." }, async () => (
  new Response(null, { status: 307, headers: { location: "/", "set-cookie": clearPreviewCookie(), "cache-control": "no-store" } })
));
