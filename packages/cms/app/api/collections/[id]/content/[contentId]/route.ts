import { z } from "zod";
import { route } from "../../../../../../core/authz/guard";
import { authorizeRecord, loadRuleLookups } from "../../../../../../core/authz/records";
import { validateRecordValues } from "../../../../../../core/blocks/service";
import { requireCollection, ruleRequest } from "../../../../../../core/content/access";
import { deleteContent, requireContent, updateContent } from "../../../../../../core/content/content-service";
import { parseId } from "../../../../../../core/content/ids";
import { flattenRecord, presentRecord, resolveValues, versionStamp } from "../../../../../../core/content/records";
import { fileActor } from "../../../../../../core/files/refs";
import { localeParams, readingLocale, writingLocale } from "../../../../../../core/i18n/request";
import { editorLocalization } from "../../../../../../core/i18n/editor";

/**
 * The editor reads one language exactly, with `?locale=fr&fallback=none`. A record with no
 * translation there yet still opens, with empty localized fields, when `?translate=1` is set.
 */
export const GET = route({ access: "rules", apiKey: true }, async ({ params, principal, request }) => {
  const translate = request.nextUrl.searchParams.get("translate") === "1";
  const raw = await requireCollection(parseId(params.id));
  const { collection, locale } = translate ? await writingLocale(raw, principal, localeParams(request)) : await readingLocale(raw, principal, localeParams(request));
  const item = await requireContent(collection, parseId(params.contentId));
  const req = { ...ruleRequest(request, {}, {}, await loadRuleLookups([collection])), locale };
  authorizeRecord(principal, collection, "view", flattenRecord(item), req);
  const localization = locale ? await editorLocalization(collection, item.id, locale, principal, req) : null;
  return { ...presentRecord(collection, item, principal), ...(localization ? { localization, translations: localization.translations } : {}) };
});

const body = z.object({
  status: z.enum(["draft", "published"]).optional(),
  values: z.array(z.object({ fieldId: z.number().int().positive(), value: z.unknown() })).max(500),
  expectedUpdatedAt: versionStamp.optional(),
});

export const PATCH = route(
  { access: "rules", apiKey: true, body, audit: "record.update" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, locale } = await writingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
    const item = await requireContent(collection, parseId(params.contentId));
    const submitted = resolveValues(collection, body);
    authorizeRecord(principal, collection, "update", flattenRecord(item), { ...ruleRequest(request, {}, submitted, await loadRuleLookups([collection])), locale });
    const values = await validateRecordValues(collection.fields, submitted, item);
    auditTarget("record", String(item.id), { collection: collection.slug, ...(locale ? { locale } : {}) });
    return presentRecord(collection, await updateContent(collection, item, body.status, values, fileActor(principal), undefined, body.expectedUpdatedAt), principal);
  },
);

export const DELETE = route({ access: "rules", apiKey: true, audit: "record.delete" }, async ({ params, principal, request, auditTarget }) => {
  const { collection } = await readingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
  const item = await requireContent(collection, parseId(params.contentId));
  authorizeRecord(principal, collection, "delete", flattenRecord(item), ruleRequest(request, {}, {}, await loadRuleLookups([collection])));
  auditTarget("record", String(item.id), { collection: collection.slug });
  await deleteContent(collection, item.id, fileActor(principal));
  return null;
});
