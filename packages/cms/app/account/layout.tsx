import { loadAdminBranding } from "../../core/auth/branding";
import type { ReactNode } from "react";
import { AppShell } from "../../components/shell/AppShell";
import { requireScopedUser } from "../../core/authz/page";
import { accountPath, adminPath } from "../../lib/paths";
import { AdminI18nProvider } from "../../components/i18n";
import { adminDirection, adminLocale, adminMessages } from "../../core/i18n/admin";
import { formatters } from "../../core/i18n/messages";

export default async function AccountLayout({ children }: { children: ReactNode }) {
  // In the scope value the dashboard would open in, so someone whose dashboard access comes from a scoped role gets the link too.
  const principal = await requireScopedUser();
  const locale = await adminLocale(principal.user.id);
  const messages = adminMessages(locale);
  const { t } = formatters(locale, messages);
  const nav = [
    ...(principal.permissions.has("dashboard:access") ? [{ name: t("nav.Dashboard"), href: adminPath(), icon: "home" }] : []),
    { name: t("nav.Account"), href: accountPath(), icon: "account" },
  ];
  const { appName, logoUrl } = await loadAdminBranding();
  const direction = adminDirection(locale);
  return (
    <AdminI18nProvider locale={locale} direction={direction} messages={messages}>
      <div lang={locale} dir={direction} className="cms-contents">
        <AppShell appName={appName} logoUrl={logoUrl} nav={nav} email={principal.user.email} impersonating={Boolean(principal.session.impersonatedBy)}>{children}</AppShell>
      </div>
    </AdminI18nProvider>
  );
}
