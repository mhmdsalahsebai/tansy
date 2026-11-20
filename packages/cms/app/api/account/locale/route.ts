import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { HttpError } from "../../../../core/http/errors";
import { isSharedAccount } from "../../../../core/auth/shared-accounts";
import { ADMIN_LOCALE_COOKIE, saveAdminLocale, supportedAdminLocale } from "../../../../core/i18n/admin";

const body = z.object({ locale: z.string().max(35).nullable() });

/** The person's dashboard and email language. Null follows their browser. */
export const PUT = route(
  { access: "authenticated", body, audit: "account.update_locale" },
  async ({ body, principal, request, auditTarget }) => {
    if (principal.kind !== "user") throw new HttpError(403, "FORBIDDEN", "Only a signed-in person has an interface language.");
    const locale = body.locale === null ? null : supportedAdminLocale(body.locale);
    if (body.locale !== null && !locale) throw new HttpError(400, "INVALID_LOCALE", "The dashboard isn't available in that language.");
    // A shared account's visitors each keep their own language, in their browser's cookie only.
    if (!isSharedAccount(principal.user.email)) await saveAdminLocale(principal.user.id, locale);
    auditTarget("user", principal.user.id, { locale });
    // Pages outside the dashboard, such as sign-in, read the cookie rather than the profile.
    const secure = request.nextUrl.protocol === "https:" ? "; Secure" : "";
    const cookie = locale ? `${ADMIN_LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}` : `${ADMIN_LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
    return new Response(JSON.stringify({ locale }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie } });
  },
);
