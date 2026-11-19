import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { authorizeRecord, decideRecord, loadRuleLookups } from "../../../../../core/authz/records";
import { requireCollectionBySlug, ruleRequest } from "../../../../../core/content/access";
import { createFlat } from "../../../../../core/content/flat";
import { listRecords, viewRecord } from "../../../../../core/content/public-records";
import { recordListQuery } from "../../../../../core/content/query";
import { flattenRecord } from "../../../../../core/content/records";
import { HttpError } from "../../../../../core/http/errors";
import { localeParams, readingLocale, writingLocale } from "../../../../../core/i18n/request";

// Next requires one parameter name per path level, so `id` holds the collection slug here.
export const GET = route({ access: "rules", apiKey: true, query: recordListQuery }, async ({ params, query, principal, request, header }) => {
  const { collection, locale, all } = await readingLocale(await requireCollectionBySlug(params.id), principal, query);
  // The language asked for. Each record's `locale` says which one it was read in, after any fallback.
  if (locale && !all) header("content-language", locale);
  const req = { ...ruleRequest(request, query, {}, await loadRuleLookups([collection])), locale };
  if (decideRecord(principal, collection, "list", {}, req) === "locked") {
    throw new HttpError(403, "RULE_LOCKED", "Only administrators can perform this action.");
  }
  return listRecords(collection, query, principal, req);
});

export const POST = route(
  { access: "rules", apiKey: true, body: z.record(z.string(), z.unknown()), audit: "record.create" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, locale } = await writingLocale(await requireCollectionBySlug(params.id), principal, localeParams(request));
    const lookups = await loadRuleLookups([collection]);
    const row = await createFlat(collection, body, principal, (record, values) => authorizeRecord(principal, collection, "create", { ...record, ...(locale ? { locale } : {}) }, { ...ruleRequest(request, {}, values, lookups), locale }));
    auditTarget("record", String(row.id), { collection: collection.slug, ...(locale ? { locale } : {}) });
    const req = { ...ruleRequest(request, {}, body, lookups), locale };
    // Being allowed to create doesn't imply being allowed to read it back.
    return decideRecord(principal, collection, "view", flattenRecord(row), req) === "allow" ? viewRecord(collection, row, {}, principal, req) : { id: row.id };
  },
);
