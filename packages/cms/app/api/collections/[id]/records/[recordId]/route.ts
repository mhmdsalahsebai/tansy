import { z } from "zod";
import { route } from "../../../../../../core/authz/guard";
import { authorizeRecord, decideRecord, loadRuleLookups } from "../../../../../../core/authz/records";
import { requireCollectionBySlug, ruleRequest } from "../../../../../../core/content/access";
import { requireContent } from "../../../../../../core/content/content-service";
import { deleteFlat, updateFlat } from "../../../../../../core/content/flat";
import { parseId } from "../../../../../../core/content/ids";
import { viewRecord } from "../../../../../../core/content/public-records";
import { recordViewQuery } from "../../../../../../core/content/query";
import { flattenRecord, ifMatchStamp } from "../../../../../../core/content/records";
import { localeParams, readingLocale, writingLocale } from "../../../../../../core/i18n/request";

export const GET = route({ access: "rules", apiKey: true, query: recordViewQuery }, async ({ params, query, principal, request, header }) => {
  const { collection, locale, all } = await readingLocale(await requireCollectionBySlug(params.id), principal, query);
  const row = await requireContent(collection, parseId(params.recordId));
  const req = { ...ruleRequest(request, query, {}, await loadRuleLookups([collection])), locale };
  authorizeRecord(principal, collection, "view", flattenRecord(row), req);
  // The language actually served, which is a fallback's when the one asked for has no published translation.
  if (locale && !all) header("content-language", typeof row.locale === "string" ? row.locale : locale);
  return viewRecord(collection, row, query, principal, req);
});

export const PATCH = route(
  { access: "rules", apiKey: true, body: z.record(z.string(), z.unknown()), audit: "record.update" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, locale } = await writingLocale(await requireCollectionBySlug(params.id), principal, localeParams(request));
    const item = await requireContent(collection, parseId(params.recordId));
    const lookups = await loadRuleLookups([collection]);
    const row = await updateFlat(collection, item, body, principal, (record, values) => authorizeRecord(principal, collection, "update", record, { ...ruleRequest(request, {}, values, lookups), locale }), ifMatchStamp(request.headers.get("if-match")));
    auditTarget("record", String(row.id), { collection: collection.slug, ...(locale ? { locale } : {}) });
    const req = { ...ruleRequest(request, {}, body, lookups), locale };
    return decideRecord(principal, collection, "view", flattenRecord(row), req) === "allow" ? viewRecord(collection, row, {}, principal, req) : { id: row.id };
  },
);

export const DELETE = route({ access: "rules", apiKey: true, audit: "record.delete" }, async ({ params, principal, request, auditTarget }) => {
  // Deleting removes the record in every language. The rule decides on it as read in the language asked for.
  const { collection } = await readingLocale(await requireCollectionBySlug(params.id), principal, localeParams(request));
  const item = await requireContent(collection, parseId(params.recordId));
  const lookups = await loadRuleLookups([collection]);
  await deleteFlat(collection, item, principal, (record) => authorizeRecord(principal, collection, "delete", record, ruleRequest(request, {}, {}, lookups)));
  auditTarget("record", String(item.id), { collection: collection.slug });
  return null;
});
