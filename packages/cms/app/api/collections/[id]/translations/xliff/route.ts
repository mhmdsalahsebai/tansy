import { z } from "zod";
import { route } from "../../../../../../core/authz/guard";
import { requireCollection, ruleRequest } from "../../../../../../core/content/access";
import { parseId } from "../../../../../../core/content/ids";
import { fileActor } from "../../../../../../core/files/refs";
import { exportXliff, importXliff, MAX_EXCHANGE_RECORDS } from "../../../../../../core/i18n/exchange";
import { localeCatalog } from "../../../../../../core/i18n/locales";
import { requestedLocale } from "../../../../../../core/i18n/request";

const query = z.object({
  from: z.string().max(35),
  to: z.string().max(35),
  /** Record ids, comma-separated. The collection's first records when left out. */
  ids: z.string().max(6000).regex(/^\d{1,10}(,\d{1,10})*$/).optional(),
});

/** XLIFF 2.0 for a translation agency or tool: each record's text in `from`, with what `to` already has. */
export const GET = route(
  { access: "permission", permission: "record:read", scope: "record", query, audit: "translation.export" },
  async ({ params, query, principal, request, auditTarget }) => {
    const collection = await requireCollection(parseId(params.id));
    const catalog = await localeCatalog();
    const from = requestedLocale(catalog, query.from, principal, collection.id);
    const to = requestedLocale(catalog, query.to, principal, collection.id);
    const ids = query.ids ? [...new Set(query.ids.split(",").map(Number))].slice(0, MAX_EXCHANGE_RECORDS + 1) : null;
    const { xliff, count, fields } = await exportXliff(collection, from, to, ids, principal, ruleRequest(request, query, {}, undefined));
    auditTarget("collection", params.id, { collection: collection.slug, from, to, records: count, fields });
    return new Response(xliff, {
      headers: {
        "content-type": "application/xliff+xml; charset=utf-8",
        "content-disposition": `attachment; filename="${collection.slug}-${from}-${to}.xlf"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);

const body = z.object({ xliff: z.string().min(1).max(20 * 1024 * 1024) });

/** A translated XLIFF file, saved as drafts in its target language through the normal write path. */
export const POST = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", body, maxBodyBytes: 21 * 1024 * 1024, audit: "translation.import" },
  async ({ params, body, principal, request, auditTarget }) => {
    const collection = await requireCollection(parseId(params.id));
    const result = await importXliff(collection, body.xliff, principal, ruleRequest(request, {}, {}, undefined), fileActor(principal));
    const counts = Object.fromEntries(["saved", "draft", "skipped"].map((outcome) => [outcome, result.results.filter((entry) => entry.outcome === outcome).length]));
    auditTarget("collection", params.id, { collection: collection.slug, from: result.from, to: result.to, ...counts });
    return result;
  },
);
