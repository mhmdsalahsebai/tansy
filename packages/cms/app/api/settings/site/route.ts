import { route } from "../../../../core/authz/guard";
import type { Principal } from "../../../../core/authz/principal";
import { HttpError } from "../../../../core/http/errors";
import { scopeProvider } from "../../../../core/scope/provider";
import { readSiteIdentity, siteIdentitySchema, writeSiteIdentity } from "../../../../core/site/identity";
import { defaultLocale, listLocales } from "../../../../core/i18n/locales";
import { installedThemes } from "../../../../core/theme/installed";

/** A scope value's own site, such as one tenant's. The instance's is under Settings → General. */
function assertScoped(principal: Principal) {
  if (!principal.scope) throw new HttpError(400, "SCOPE_REQUIRED", `Choose a ${(scopeProvider()?.provider.label ?? "scope").toLowerCase()} first: each has its own site name, logo and colour.`);
}

export const GET = route({ access: "permission", permission: "setting:site" }, async ({ principal }) => {
  assertScoped(principal);
  return readSiteIdentity();
});

export const PUT = route(
  { access: "permission", permission: "setting:site", body: siteIdentitySchema, audit: "setting.site_update" },
  async ({ body, principal, auditTarget }) => {
    assertScoped(principal);
    const before = await readSiteIdentity();
    // Only languages that exist and aren't the default can be left out.
    const [locales, primary] = await Promise.all([listLocales(), defaultLocale()]);
    const known = new Set(locales.map((locale) => locale.code));
    const hiddenLocales = [...new Set(body.hiddenLocales)].filter((code) => known.has(code) && code !== primary);
    // Only a theme this build installs. Anything else is stored as none, which serves the default theme.
    const theme = installedThemes().some((installed) => installed.name === body.theme) ? body.theme : "";
    const saved = await writeSiteIdentity({ ...body, hiddenLocales, theme }, principal.user.id);
    auditTarget("setting", "site", { changed: (Object.keys(saved) as Array<keyof typeof saved>).filter((name) => JSON.stringify(saved[name]) !== JSON.stringify(before[name])) });
    return saved;
  },
);
