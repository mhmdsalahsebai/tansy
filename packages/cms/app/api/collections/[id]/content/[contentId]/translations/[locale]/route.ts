import { route } from "../../../../../../../../core/authz/guard";
import { authorizeRecord, loadRuleLookups } from "../../../../../../../../core/authz/records";
import { requireCollection, ruleRequest } from "../../../../../../../../core/content/access";
import { deleteTranslation, requireContent } from "../../../../../../../../core/content/content-service";
import { parseId } from "../../../../../../../../core/content/ids";
import { flattenRecord } from "../../../../../../../../core/content/records";
import { fileActor } from "../../../../../../../../core/files/refs";
import { readingLocale } from "../../../../../../../../core/i18n/request";

/** Removing a translation is an update to the record, by someone who may edit that language. */
export const DELETE = route({ access: "rules", apiKey: true, audit: "record.translation.delete" }, async ({ params, principal, request, auditTarget }) => {
  const { collection, locale } = await readingLocale(await requireCollection(parseId(params.id)), principal, { locale: params.locale, fallback: "none" });
  const item = await requireContent(collection, parseId(params.contentId));
  authorizeRecord(principal, collection, "update", flattenRecord(item), { ...ruleRequest(request, {}, {}, await loadRuleLookups([collection])), locale });
  await deleteTranslation(collection, item, locale ?? params.locale, fileActor(principal));
  auditTarget("record", String(item.id), { collection: collection.slug, locale });
  return null;
});
