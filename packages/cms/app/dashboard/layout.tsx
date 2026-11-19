import { loadAdminBranding } from "../../core/auth/branding";
import type { ReactNode } from "react";
import { pluginNav } from "../../core/extend/admin-nav";
import { AdminAccess } from "../../components/admin-client";
import { AppShell, type NavItem } from "../../components/shell/AppShell";
import type { Permission } from "../../core/authz/permissions";
import { requirePage } from "../../core/authz/page";
import { sidebarCollapsed } from "../../core/ui/preferences";
import { accountPath, adminPath } from "../../lib/paths";
import { adminDirection, adminLocale, adminMessages } from "../../core/i18n/admin";
import { formatters } from "../../core/i18n/messages";
import { installedThemes } from "../../core/theme/installed";
import { getCmsConfig } from "../../core/config";
import { scopeProvider } from "../../core/scope/provider";
import { AdminI18nProvider } from "../../components/i18n";

/** `scoped`: shown only when a plugin provides row scopes, since the page is about one scope value. */
const NAV: Array<NavItem & { permission?: Permission; scoped?: true }> = [
  { name: "Overview", href: adminPath(), icon: "home" },
  { group: "Content", name: "Collections", href: adminPath("/collections"), icon: "collections", permission: "collection:read" },
  { group: "Content", name: "Reviews", href: adminPath("/reviews"), icon: "reviews", permission: "dashboard:access" },
  { group: "Content", name: "Files", href: adminPath("/files"), icon: "files", permission: "file:list" },
  { group: "Content", name: "Redirects", href: adminPath("/redirects"), icon: "redirects", permission: "redirect:read" },
  { group: "Content", name: "Trash", href: adminPath("/trash"), icon: "trash", permission: "dashboard:access" },
  { group: "Content", name: "Site", href: adminPath("/site"), icon: "site", permission: "setting:site", scoped: true },
  { group: "Build", name: "Schema", href: adminPath("/schema"), icon: "schema", permission: "collection:read" },
  { group: "Build", name: "Blocks", href: adminPath("/blocks"), icon: "blocks", permission: "collection:read" },
  { group: "Build", name: "Field presets", href: adminPath("/field-presets"), icon: "presets", permission: "collection:read" },
  { group: "Build", name: "Webhooks", href: adminPath("/webhooks"), icon: "webhooks", permission: "webhook:read" },
  { group: "Access", name: "Users", href: adminPath("/users"), icon: "users", permission: "user:list" },
  { group: "Access", name: "Roles", href: adminPath("/roles"), icon: "roles", permission: "role:list" },
  { group: "System", name: "Audit log", href: adminPath("/audit"), icon: "audit", permission: "audit:read" },
  { group: "System", name: "Settings", href: adminPath("/settings"), icon: "settings", permission: "setting:read" },
  { group: "System", name: "Languages", href: adminPath("/languages"), icon: "languages", permission: "setting:read" },
  { group: "System", name: "Extensions", href: adminPath("/extensions"), icon: "extensions", permission: "setting:read" },
  { group: "System", name: "Account", href: accountPath(), icon: "account" },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const principal = await requirePage();
  const locale = await adminLocale(principal.user.id);
  const messages = adminMessages(locale);
  const { t } = formatters(locale, messages);
  const { sections, loose, shortcuts, switchers } = await pluginNav(principal.permissions, { t, locale });
  const builtIn: NavItem[] = NAV.filter((item) => (!item.permission || principal.permissions.has(item.permission)) && (!item.scoped || scopeProvider() !== null)).map(({ name, href, group, icon }) => ({ name: t(`nav.${name}`), href, group: group && t(`nav.groups.${group}`), icon }));
  // A plugin with a section gets its own entry after Overview. Pages of plugins without one share a group.
  const nav: NavItem[] = [builtIn[0], ...sections.map((section) => ({ ...section, group: t("nav.groups.Apps"), icon: section.icon ?? "extensions" })), ...builtIn.slice(1), ...loose.map((item) => ({ ...item, group: t("nav.groups.Plugins") }))];
  const { appName, logoUrl } = await loadAdminBranding();
  const direction = adminDirection(locale);
  return (
    <AdminI18nProvider locale={locale} direction={direction} messages={messages}>
      <div lang={locale} dir={direction} className="cms-contents">
        <AppShell appName={appName} logoUrl={logoUrl} nav={nav} shortcuts={shortcuts} switchers={switchers} siteHref={installedThemes().length ? "/" : undefined} collapsed={await sidebarCollapsed()} email={principal.user.email} impersonating={Boolean(principal.session.impersonatedBy)}><AdminAccess permissions={[...principal.permissions]}>{children}</AdminAccess></AppShell>
      </div>
    </AdminI18nProvider>
  );
}
