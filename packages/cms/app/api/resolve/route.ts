import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { decideRecord } from "../../../core/authz/records";
import { ruleRequest } from "../../../core/content/access";
import { recordViewQuery } from "../../../core/content/query";
import { notFound } from "../../../core/http/errors";
import { resolveAddress } from "../../../core/urls/resolve";

const query = recordViewQuery.extend({ path: z.string().min(1).max(4096) });

/** Turns a site address into a record or a redirect. See resolveAddress for what an unviewable record looks like. */
export const GET = route({ access: "rules", apiKey: true, query }, async ({ query, principal, request }) => {
  const { path, ...view } = query;
  // `locale` names the language of a path without its prefix. Otherwise the prefix, or the site's host, says.
  const address = await resolveAddress(path, view, principal, (lookups) => ruleRequest(request, query, {}, lookups), (collection, record, req) => decideRecord(principal, collection, "view", record, req) === "allow", { locale: view.locale, host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  if (!address) throw notFound("Page");
  return address;
});
