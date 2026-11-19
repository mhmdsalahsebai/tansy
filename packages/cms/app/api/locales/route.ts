import { route } from "../../../core/authz/guard";
import { localeCatalog, localizationSettings } from "../../../core/i18n/locales";

/** Public: a site needs its languages before anyone signs in. Hidden languages never appear. */
export const GET = route({ access: "public", reason: "Sites list their languages to visitors." }, async () => {
  const [catalog, settings] = await Promise.all([localeCatalog(), localizationSettings()]);
  const items = catalog.locales.filter((locale) => locale.public);
  return {
    defaultLocale: catalog.defaultLocale,
    routing: { mode: settings.routing.mode, prefixDefault: settings.routing.prefixDefault, domains: settings.routing.domains },
    items: items.map(({ code, label, direction, fallback }) => ({ code, label, direction, fallback, chain: catalog.chain(code) })),
    // Owners' changes to the theme's words. Site text is shown to every visitor anyway.
    messages: Object.fromEntries(Object.entries(settings.siteText).filter(([code]) => items.some((item) => item.code === code))),
  };
});
