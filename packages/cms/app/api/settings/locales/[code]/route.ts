import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { deleteLocale, localeUpdate, updateLocale } from "../../../../../core/i18n/locales";

export const PATCH = route(
  { access: "permission", permission: "setting:update", body: localeUpdate, audit: "locale.update" },
  async ({ params, body, auditTarget }) => {
    const updated = await updateLocale(params.code, body);
    auditTarget("locale", updated.code, { fields: Object.keys(body) });
    return updated;
  },
);

/** Removing a language keeps its translations unless `purge` is set, which deletes them for good. */
const query = z.object({ purge: z.enum(["true", "false"]).optional().transform((value) => value === "true") });

export const DELETE = route(
  { access: "permission", permission: "setting:update", query, fresh: true, audit: "locale.delete" },
  async ({ params, query, auditTarget }) => {
    const result = await deleteLocale(params.code, query.purge);
    auditTarget("locale", params.code, { purged: result.purged });
    return result;
  },
);
