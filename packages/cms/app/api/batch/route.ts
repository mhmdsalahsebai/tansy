import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { authorizeRecord, loadRuleLookups } from "../../../core/authz/records";
import { allCollections, ruleRequest } from "../../../core/content/access";
import { runBatch } from "../../../core/content/batch";
import { viewRecord } from "../../../core/content/public-records";
import { HttpError } from "../../../core/http/errors";

const body = z.object({
  requests: z.array(z.object({
    method: z.enum(["POST", "PATCH", "DELETE"]),
    url: z.string().max(300),
    body: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(1000),
});

export const POST = route(
  { access: "rules", apiKey: true, body, audit: "record.batch", maxBodyBytes: 8 * 1024 * 1024 },
  async ({ body, principal, request, runtime, auditTarget }) => {
    const { enabled, maxRequests } = runtime.settings.batch;
    if (!enabled) throw new HttpError(403, "BATCH_DISABLED", "Batch requests are not allowed.");
    if (body.requests.length > maxRequests) throw new HttpError(400, "BATCH_TOO_LARGE", `A batch can hold at most ${maxRequests} requests.`);

    const lookups = await loadRuleLookups(await allCollections());
    const results = await runBatch(body.requests, principal, (collection, action, record, values, locale) =>
      authorizeRecord(principal, collection, action, record, { ...ruleRequest(request, {}, values, lookups), locale }));

    auditTarget("batch", String(results.length), { operations: results.slice(0, 200).map(({ collection, action, row }) => ({ collection: collection.slug, action, id: row.id })) });
    const req = ruleRequest(request, {}, {}, lookups);
    return Promise.all(results.map(async ({ collection, action, row }) => (action === "delete" ? { status: 204 } : { status: 200, body: await viewRecord(collection, row, {}, principal, req) })));
  },
);
