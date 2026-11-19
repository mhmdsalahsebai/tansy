import { route } from "../../../../../core/authz/guard";
import { decideRecord } from "../../../../../core/authz/records";
import { ruleRequest } from "../../../../../core/content/access";
import { canReadFile, requireFile } from "../../../../../core/files/service";
import { createFileToken } from "../../../../../core/files/tokens";
import { notFound } from "../../../../../core/http/errors";

/** For clients that can't send a session or API key, such as an <img> on another site. */
export const POST = route({ access: "rules", apiKey: true, audit: "file.token" }, async ({ params, principal, request, auditTarget }) => {
  const file = await requireFile(params.id);
  const req = ruleRequest(request, {}, {});
  if (!(await canReadFile(file, principal, (collection, record, lookups) => decideRecord(principal, collection, "view", record, { ...req, lookups }) === "allow"))) throw notFound("File");
  auditTarget("file", file.id);
  return createFileToken(file.id);
});
