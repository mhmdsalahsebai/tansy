import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { decideRecord } from "../../../../../core/authz/records";
import { ruleRequest } from "../../../../../core/content/access";
import { canReadFile, presentFile, requireFile } from "../../../../../core/files/service";
import { fileTextChain, fileTextLocale } from "../../../../../core/files/text";
import { notFound } from "../../../../../core/http/errors";

const query = z.object({ locale: z.string().max(35).optional() });

/** `?locale=` reads the file's text in that language, falling back along its chain. */
export const GET = route({ access: "rules", apiKey: true, query }, async ({ params, query, principal, request }) => {
  const file = await requireFile(params.id);
  const req = ruleRequest(request, {}, {});
  if (!(await canReadFile(file, principal, (collection, record, lookups) => decideRecord(principal, collection, "view", record, { ...req, lookups }) === "allow"))) throw notFound("File");
  return presentFile(file, await fileTextChain(await fileTextLocale(query.locale, principal.permissions.has("file:read"))));
});
