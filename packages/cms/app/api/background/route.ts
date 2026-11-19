import { route } from "../../../core/authz/guard";
import { runFromEndpoint } from "../../../core/background/endpoint";

/** Called by Vercel Cron, any cron service, or `tansy tick`, where the host doesn't keep timers running. */
export const GET = route(
  { access: "public", reason: "Runs background work for a cron service; authorized by Authorization: Bearer CRON_SECRET, checked in constant time" },
  async ({ request }) => runFromEndpoint(request.headers.get("authorization")),
);
