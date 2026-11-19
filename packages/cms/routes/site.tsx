import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { cache, type ReactNode } from "react";
import { AdminBar } from "../components/site/AdminBar";
import { ThemedPage } from "../components/site/ThemedPage";
import type { Renderers } from "../components/stream/StreamField";
import type { CmsConfig } from "../core/auth/extensions";
import { resolveLanding } from "../core/authz/page";
import { negotiateLocale } from "../core/i18n/codes";
import { localeCatalog, localizationSettings } from "../core/i18n/locales";
import { localizePath } from "../core/i18n/routing";
import { loadSitePage, pageMetadata, pageNumber, type LoadedPage, type SiteTheme } from "../core/site/page";
import { previewTokenFromCookie } from "../core/site/preview";
import { createSite } from "../core/site/reader";
import { siteAdminBar } from "../core/site/admin-bar";
import { withScope } from "../core/scope/context";
import { siteScope } from "../core/scope/site";
import type { ThemeComponents } from "../core/theme/define";
import { installedThemes, themeNamed } from "../core/theme/installed";
import { chosenThemeHere } from "../core/site/identity";
import { apiPath } from "../lib/paths";

type PageProps = { params: Promise<{ path?: string[] }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/**
 * The themes a build has, as .tansy/theme exports them: one theme's components on their own, or a
 * map by theme name where the config lists several.
 */
type ThemeEntry = ThemeComponents | Record<string, ThemeComponents>;

interface SiteEntry {
  /** The default export of .tansy/theme. */
  components: ThemeEntry | null;
  /** The default export of .tansy/render, plugins' front-end components. */
  renderers?: Renderers;
}

/** A map has no `templates` of its own: every theme must declare some, so this tells the two apart. */
const isOneTheme = (entry: ThemeEntry): entry is ThemeComponents => {
  const templates = (entry as ThemeComponents).templates;
  return typeof templates === "object" && templates !== null;
};

const componentsNamed = (entry: ThemeEntry, name: string): ThemeComponents | null =>
  (isOneTheme(entry) ? entry : Object.hasOwn(entry, name) ? entry[name] : null);

/**
 * The theme to serve this request in: the one the current scope value chose under Site, such as
 * one tenant's, and the build's default where it chose none or chose a theme since removed. Read
 * inside the scope value, because the choice is that value's own setting.
 */
async function themeHere(config: CmsConfig, entry: ThemeEntry): Promise<SiteTheme | null> {
  const manifest = themeNamed(await chosenThemeHere(), config);
  if (!manifest) return null;
  const components = componentsNamed(entry, manifest.name);
  return components ? { manifest, components } : null;
}

/** The address as the browser asked for it. Next.js hands over segments still percent-encoded, and normalizePath decodes them once. */
const requestedPath = (segments: string[] | undefined) => `/${(segments ?? []).join("/")}`;

function createLoader(config: CmsConfig, { components, renderers }: SiteEntry) {
  const reader = createSite(config);
  // The components where this build serves a site at all. Which theme it serves is a per-request answer.
  const installed = components !== null && installedThemes(config).length > 0 ? components : null;
  // Once per request, as metadata and the page both need the theme and the page.
  const load = cache(async (path: string, page: number): Promise<{ theme: SiteTheme | null; page: LoadedPage | null }> => {
    if (installed === null) return { theme: null, page: null };
    const requestHeaders = await headers();
    // Row scopes: the page reads in the scope value its host or path is for, such as one tenant's site.
    const scope = await siteScope(requestHeaders, path);
    if (!scope) return { theme: null, page: { type: "missing" } };
    const previewToken = await previewTokenFromCookie();
    return withScope(scope.value, async () => {
      const theme = await themeHere(config, installed);
      if (!theme) return { theme: null, page: null };
      return { theme, page: await loadSitePage(theme, reader, path, { previewToken, renderers, page, host: requestHeaders.get("host") }) };
    });
  });
  return { load };
}

/**
 * The site's catch-all page. Records are read as a signed-out visitor, even for someone
 * signed in to the dashboard, so what an editor sees is what the public gets. A preview
 * token changes that for the one record it names. A members' page, one only the signed-in
 * person may view or with queries marked `viewer`, reads as them under API rules alone.
 */
export function createSitePage(config: CmsConfig, { components, renderers }: SiteEntry) {
  const { load } = createLoader(config, { components, renderers });
  return async function SiteCatchAll({ params, searchParams }: PageProps): Promise<ReactNode> {
    const path = requestedPath((await params).path);
    if (path === "/") {
      const to = await languageLanding();
      if (to) redirect(to);
    }
    const { theme, page } = await load(path, pageNumber((await searchParams)?.page));
    if (page?.type === "redirect") {
      if (page.status === 301 || page.status === 308) permanentRedirect(page.to);
      redirect(page.to);
    }
    if (!theme || !page || page.type === "missing") {
      // A site with no page at its root behaves like the CMS on its own: sign-in, or the dashboard.
      if (path === "/") redirect(await resolveLanding());
      notFound();
    }
    const record = page.props.record as { id?: unknown } | null;
    const bar = await siteAdminBar({ collection: page.props.collection, recordId: typeof record?.id === "number" ? record.id : null });
    return (
      <>
        {bar && <AdminBar bar={bar} />}
        <ThemedPage theme={theme} page={page} renderers={renderers} exitPreviewHref={apiPath("/preview/exit")} />
      </>
    );
  };
}

/** A site can remember a visitor's choice of language in this cookie, for the home page. */
const LANGUAGE_COOKIE = "cms-site-locale";

/**
 * At "/" only, and only when the owner turned it on: a first visit goes to the language the
 * browser asks for. A deep link is never redirected, since crawlers send no language and
 * people share links. A visitor who has picked a language keeps it through a cookie.
 */
async function languageLanding(): Promise<string | null> {
  const [settings, catalog] = await Promise.all([localizationSettings(), localeCatalog()]);
  const codes = catalog.locales.filter((locale) => locale.public).map((locale) => locale.code);
  if (!settings.routing.detectRoot || settings.routing.mode !== "prefix" || codes.length < 2) return null;
  const remembered = (await cookies()).get(LANGUAGE_COOKIE)?.value;
  const wanted = remembered && codes.includes(remembered) ? remembered : negotiateLocale((await headers()).get("accept-language"), codes) ?? catalog.defaultLocale;
  if (wanted === catalog.defaultLocale && !settings.routing.prefixDefault) return null;
  return localizePath("/", wanted, settings.routing, catalog.defaultLocale).path;
}

/** The page's title and description, from `generateMetadata` in the same entry file. */
export function createSiteMetadata(config: CmsConfig, { components, renderers }: SiteEntry) {
  const { load } = createLoader(config, { components, renderers });
  return async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
    const { theme, page } = await load(requestedPath((await params).path), pageNumber((await searchParams)?.page));
    return theme && page?.type === "page" ? pageMetadata(theme, page, renderers) : {};
  };
}
