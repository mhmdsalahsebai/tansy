import { revalidateTag } from "next/cache";
import { verifyWebhook } from "../sdk/index";

export interface RevalidateRouteOptions {
  /** The secret shown once when the webhook was created under Dashboard → Webhooks. */
  secret: string | undefined;
  /** The tag passed to `client.reader({ tags })`. */
  tag?: string;
}

/**
 * A route handler for a headless site that clears its cached reads when content changes.
 * Point a webhook in the CMS at it:
 *
 *   // app/api/cms-revalidate/route.ts
 *   export const { POST } = createRevalidateRoute({ secret: process.env.TANSY_WEBHOOK_SECRET });
 *
 * Only a request signed with the webhook's secret clears anything. It clears the whole tag,
 * because a rule or a list on one page can depend on records of any collection.
 */
export function createRevalidateRoute({ secret, tag = "cms" }: RevalidateRouteOptions) {
  return {
    async POST(request: Request) {
      if (!secret) return Response.json({ error: "Set the webhook's secret, such as TANSY_WEBHOOK_SECRET." }, { status: 500 });
      const body = await request.text();
      if (!(await verifyWebhook(secret, request.headers.get("x-cms-signature"), body))) return Response.json({ error: "Invalid signature." }, { status: 401 });
      // Expires now, so the next visitor gets fresh content rather than one stale page first.
      revalidateTag(tag, { expire: 0 });
      return new Response(null, { status: 204 });
    },
  };
}

export { verifyWebhook } from "../sdk/index";
