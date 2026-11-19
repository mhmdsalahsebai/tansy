import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { localizationSettings, setDefaultLocale, setRouting, setSiteText } from "../../../../core/i18n/locales";

const body = z.object({
  defaultLocale: z.string().max(35).optional(),
  routing: z.object({
    mode: z.enum(["prefix", "domains", "none"]).optional(),
    prefixDefault: z.boolean().optional(),
    domains: z.record(z.string().max(35), z.string().max(253)).optional(),
    detectRoot: z.boolean().optional(),
  }).optional(),
  /** Replaces one language's changes to the theme's words. An empty object removes them. */
  siteText: z.object({ locale: z.string().max(35), messages: z.record(z.string(), z.unknown()) }).optional(),
});

export const PUT = route(
  { access: "permission", permission: "setting:update", body, audit: "localization.update" },
  async ({ body, principal, auditTarget }) => {
    if (body.routing) await setRouting({ ...(await localizationSettings()).routing, ...body.routing }, principal.user.id);
    if (body.defaultLocale) await setDefaultLocale(body.defaultLocale, principal.user.id);
    if (body.siteText) await setSiteText(body.siteText.locale, body.siteText.messages, principal.user.id);
    const settings = await localizationSettings();
    auditTarget("localization", "settings", { defaultLocale: settings.defaultLocale, routing: settings.routing.mode, ...(body.siteText ? { siteText: body.siteText.locale } : {}) });
    return settings;
  },
);
