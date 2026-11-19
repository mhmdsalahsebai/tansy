import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { authorizeRecord, decideRecord, listRuleWhere, loadRuleLookups } from "../../../../../core/authz/records";
import { validateRecordValues } from "../../../../../core/blocks/service";
import { requireCollection, ruleRequest } from "../../../../../core/content/access";
import { createContent, listContentPage, recordColumns } from "../../../../../core/content/content-service";
import { parseId } from "../../../../../core/content/ids";
import { presentRecord, resolveValues } from "../../../../../core/content/records";
import { withDefaults } from "../../../../../core/fields/validate";
import { fileActor } from "../../../../../core/files/refs";
import { HttpError } from "../../../../../core/http/errors";
import { localeParams, readingLocale, writingLocale } from "../../../../../core/i18n/request";
import { translationStatuses } from "../../../../../core/i18n/storage";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(30),
});

export const GET = route({ access: "rules", apiKey: true, query }, async ({ params, query, principal, request }) => {
  const { collection, locale } = await readingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
  const req = { ...ruleRequest(request, query, {}, await loadRuleLookups([collection])), locale };
  // A locked rule answers 403 for the whole list; a failed expression just filters.
  if (decideRecord(principal, collection, "list", {}, req) === "locked") {
    throw new HttpError(403, "RULE_LOCKED", "Only administrators can perform this action.");
  }
  const { totalItems, items } = await listContentPage(collection, listRuleWhere(principal, collection, req, recordColumns(collection)), query);
  // Each record's translations, for the grid's language badges.
  const statuses = await translationStatuses(collection, items.map((row) => row.id));
  return { page: query.page, perPage: query.perPage, totalItems, items: items.map((row) => ({ ...presentRecord(collection, row, principal), ...(statuses.size ? { translations: statuses.get(row.id) ?? [] } : {}) })) };
});

const contentBody = z.object({
  status: z.enum(["draft", "published"]).optional(),
  values: z.array(z.object({ fieldId: z.number().int().positive(), value: z.unknown() })).max(500),
});

export const POST = route(
  { access: "rules", apiKey: true, body: contentBody, audit: "record.create" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, locale } = await writingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
    const submitted = resolveValues(collection, body);
    const createdById = principal.kind === "anonymous" ? null : principal.user.id;
    const candidate = withDefaults(collection.fields, submitted);
    authorizeRecord(principal, collection, "create", { status: "draft", createdById: createdById ?? "", ...(locale ? { locale } : {}), ...candidate }, { ...ruleRequest(request, {}, submitted, await loadRuleLookups([collection])), locale });
    // After the rule check, so callers who may not create learn nothing about the schema.
    const values = await validateRecordValues(collection.fields, candidate);
    const row = await createContent(collection, body.status, values, createdById, fileActor(principal));
    auditTarget("record", String(row.id), { collection: collection.slug, ...(locale ? { locale } : {}) });
    return presentRecord(collection, row, principal);
  },
);
