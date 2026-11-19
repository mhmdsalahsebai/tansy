import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { decideRecord } from "../../../../core/authz/records";
import { notFound } from "../../../../core/http/errors";
import { loadPreview, previewCookie } from "../../../../core/site/preview";

const query = z.object({ token: z.string().min(1).max(600) });

/** For a site in this app: moves the token into a cookie and opens the record's address. */
export const GET = route({ access: "rules", query }, async ({ query }) => {
  const preview = await loadPreview(query.token, (issuer, collection, record, request) => decideRecord(issuer, collection, "view", record, request) === "allow");
  if (!preview?.path) throw notFound("Preview");
  // Relative, so a reverse proxy's internal address can't end up in the header.
  return new Response(null, { status: 307, headers: { location: preview.path, "set-cookie": previewCookie(query.token), "cache-control": "no-store" } });
});
