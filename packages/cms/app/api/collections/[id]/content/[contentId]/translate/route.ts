import { z } from "zod";
import { route } from "../../../../../../../core/authz/guard";
import { requireCollection, ruleRequest } from "../../../../../../../core/content/access";
import { parseId } from "../../../../../../../core/content/ids";
import { requestedLocale } from "../../../../../../../core/i18n/request";
import { localeCatalog } from "../../../../../../../core/i18n/locales";
import { suggestTranslation } from "../../../../../../../core/i18n/translate";

const body = z.object({
  from: z.string().max(35),
  to: z.string().max(35),
  /** The plugin whose translator to use. The first installed one when left out. */
  provider: z.string().max(60).optional(),
});

/**
 * A machine translation of one record's localized text, for the editor to put in the form
 * unsaved. Only text the caller may read in `from` is sent, never hidden fields, and the
 * audit entry names the languages and fields, never the text.
 */
export const POST = route(
  { access: "permission", permission: "record:read", scope: "record", body, audit: "record.translate" },
  async ({ params, body, principal, request, auditTarget }) => {
    const collection = await requireCollection(parseId(params.id));
    const catalog = await localeCatalog();
    const from = requestedLocale(catalog, body.from, principal, collection.id);
    const to = requestedLocale(catalog, body.to, principal, collection.id);
    const suggestion = await suggestTranslation(collection, parseId(params.contentId), from, to, principal, ruleRequest(request, {}, {}, undefined), body.provider);
    auditTarget("record", params.contentId, { collection: collection.slug, from, to, provider: suggestion.provider, fields: suggestion.fields });
    return suggestion;
  },
);
