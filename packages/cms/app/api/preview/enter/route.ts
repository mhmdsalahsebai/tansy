import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { decideRecord } from "../../../../core/authz/records";
import { notFound } from "../../../../core/http/errors";
import { currentScopeValue } from "../../../../core/scope/context";
import { scopeBasePathOf } from "../../../../core/scope/provider";
import { loadPreview, previewCookie } from "../../../../core/site/preview";
import { withBasePath } from "../../../../core/urls/base-path";

const query = z.object({ token: z.string().min(1).max(600) });

/** For a site in this app: moves the token into a cookie and opens the record's address. */
export const GET = route({ access: "rules", query }, async ({ query }) => {
  const preview = await loadPreview(query.token, (issuer, collection, record, request) => decideRecord(issuer, collection, "view", record, request) === "allow");
  if (!preview?.path) throw notFound("Preview");
  // A scope value whose site is served under a path prefix, such as one tenant's /acme, is
  // where its records live, so the preview opens there.
  const location = withBasePath(await scopeBasePathOf(currentScopeValue()), preview.path);
  // Relative, so a reverse proxy's internal address can't end up in the header.
  return new Response(null, { status: 307, headers: { location, "set-cookie": previewCookie(query.token), "cache-control": "no-store" } });
});
