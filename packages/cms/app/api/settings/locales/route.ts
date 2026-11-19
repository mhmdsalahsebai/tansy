import { route } from "../../../../core/authz/guard";
import { createLocale, listLocales, localeInput, localizationSettings } from "../../../../core/i18n/locales";

export const GET = route({ access: "permission", permission: "setting:read" }, async () => {
  const [locales, settings] = await Promise.all([listLocales(), localizationSettings()]);
  return { defaultLocale: settings.defaultLocale, routing: settings.routing, siteText: settings.siteText, items: locales };
});

export const POST = route(
  { access: "permission", permission: "setting:update", body: localeInput, audit: "locale.create" },
  async ({ body, auditTarget }) => {
    const created = await createLocale(body);
    auditTarget("locale", created.code, { public: created.public });
    return created;
  },
);
