import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { decideRecord } from "../../../../core/authz/records";
import { ruleRequest } from "../../../../core/content/access";
import { canReadFile, deleteFile, requireFile, serveFile, THUMB_SIZES } from "../../../../core/files/service";
import { verifyFileToken } from "../../../../core/files/tokens";
import { notFound } from "../../../../core/http/errors";

const query = z.object({
  thumb: z.enum(THUMB_SIZES).optional(),
  token: z.string().max(100).optional(),
});

export const GET = route({ access: "rules", apiKey: true, query }, async ({ params, query, principal, request }) => {
  const file = await requireFile(params.id);
  const req = ruleRequest(request, { thumb: query.thumb }, {});
  const allowed = verifyFileToken(file.id, query.token) || (await canReadFile(file, principal, (collection, record, lookups) => decideRecord(principal, collection, "view", record, { ...req, lookups }) === "allow"));
  if (!allowed) throw notFound("File");
  return serveFile(file, { thumb: query.thumb, range: request.headers.get("range") });
});

export const DELETE = route({ access: "permission", permission: "file:delete", apiKey: true, audit: "file.delete" }, async ({ params, auditTarget }) => {
  const file = await requireFile(params.id);
  auditTarget("file", file.id, { name: file.name });
  await deleteFile(file);
  return null;
});
