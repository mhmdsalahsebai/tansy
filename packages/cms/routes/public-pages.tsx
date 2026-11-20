import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import AccountLayout from "../app/account/layout";
import AccountPage from "../app/account/page";
import Landing from "../app/landing";
import type { CmsConfig } from "../core/auth/extensions";
import { provideAdminConfig, provideCmsConfig } from "../core/config";
import type { AdminConfig } from "../core/extend/admin";
import { createMatcher } from "./match";
import { authPages } from "./pages-table.generated";
import { AdminI18nProvider } from "../components/i18n";
import { AuthConfigProvider } from "../components/auth/AuthConfig";
import { loadPublicAuthConfig } from "../core/auth/public-config";
import { adminDirection, adminLocale, adminMessages } from "../core/i18n/admin";

type Query = Record<string, string | string[] | undefined>;
type AuthPageProps = { params: Promise<{ cms: string[] }>; searchParams: Promise<Query> };
type TablePage = (props: { searchParams: Promise<Query> }) => ReactNode | Promise<ReactNode>;

const match = createMatcher(authPages);

export function createLandingPage(config: CmsConfig) {
  provideCmsConfig(config);
  return Landing;
}

/** The pages shown before there is a session. Each one is public by design, and everything they do goes through the guarded API. */
export function createAuthPage(config: CmsConfig) {
  provideCmsConfig(config);
  return async function AuthCatchAll({ params, searchParams }: AuthPageProps) {
    const found = match((await params).cms);
    if (!found) notFound();
    const Page = (await found.entry.load()).default as TablePage;
    // A plain copy, because some of these are client components and the original is tied to this request.
    // Nobody is signed in yet, so the language comes from the remembered choice or the browser.
    // The enabled methods and branding come with the page, so the form paints whole instead of filling in after a request.
    const [locale, authConfig, query] = await Promise.all([adminLocale(), loadPublicAuthConfig(), searchParams]);
    const direction = adminDirection(locale);
    return (
      <AdminI18nProvider locale={locale} direction={direction} messages={adminMessages(locale)}>
        <AuthConfigProvider value={authConfig}>
          <div lang={locale} dir={direction} className="cms-contents"><Page searchParams={Promise.resolve({ ...query })} /></div>
        </AuthConfigProvider>
      </AdminI18nProvider>
    );
  };
}

/**
 * Outside the dashboard shell, because an account needs no dashboard access. `admin` brings
 * plugins' account panels. Without it, as in entries written before they existed, there are none.
 */
export function createAccountPage(config: CmsConfig, admin?: AdminConfig) {
  provideCmsConfig(config);
  if (admin) {
    const enabled = new Set((config.plugins ?? []).map(({ name }) => name));
    provideAdminConfig({ ...admin, plugins: admin.plugins.filter(({ name }) => enabled.has(name)) });
  }
  return async function CmsAccountPage({ searchParams }: { searchParams: Promise<{ denied?: string; enroll?: string }> }) {
    return <AccountLayout><AccountPage searchParams={searchParams} /></AccountLayout>;
  };
}
