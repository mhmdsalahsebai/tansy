import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { parseId } from "../../../../../core/content/ids";
import { updateCollectionLocalization } from "../../../../../core/schema/service";
import { requireCollection, ruleRequest } from "../../../../../core/content/access";
import { editorLocalization } from "../../../../../core/i18n/editor";
import { localeParams, writingLocale } from "../../../../../core/i18n/request";

/** The languages a new record can be written in, for the editor. Null for a collection with one language. */
export const GET = route({ access: "permission", permission: "record:read", scope: "record" }, async ({ params, principal, request }) => {
  const { collection, locale } = await writingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
  return { localization: locale ? await editorLocalization(collection, null, locale, principal, ruleRequest(request, {}, {}, undefined)) : null };
});

const body = z.object({
  enabled: z.boolean(),
  fallback: z.enum(["chain", "none"]).optional(),
  fieldFallback: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

/** Turning localization off keeps the default language and deletes the rest, so it needs `confirm`. */
export const PUT = route(
  { access: "permission", permission: "collection:update", body, audit: "collection.update_localization", fresh: true },
  async ({ params, body, principal, auditTarget }) => {
    const { confirm, ...settings } = body;
    const collection = await updateCollectionLocalization(parseId(params.id), settings, confirm === true, principal.user.id);
    auditTarget("collection", params.id, { localization: collection.localization });
    return collection;
  },
);
