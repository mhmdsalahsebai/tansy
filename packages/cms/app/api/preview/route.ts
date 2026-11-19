import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { decideRecord } from "../../../core/authz/records";
import { notFound } from "../../../core/http/errors";
import { loadPreview } from "../../../core/site/preview";

const query = z.object({ token: z.string().min(1).max(600) });

/** What a headless site reads with a preview token. The token is the credential, and loadPreview checks its maker's access through decideRecord. */
export const GET = route({ access: "rules", query }, async ({ query }) => {
  const preview = await loadPreview(query.token, (issuer, collection, record, request) => decideRecord(issuer, collection, "view", record, request) === "allow");
  if (!preview) throw notFound("Preview");
  return preview;
});
