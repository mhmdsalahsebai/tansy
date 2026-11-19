/** No server imports: the dashboard, the site layer and headless sites build addresses with this. */

export interface SiteRouting {
  mode: "prefix" | "domains" | "none";
  prefixDefault: boolean;
  domains: Record<string, string>;
}

export interface LocalizedPath {
  locale: string;
  /** The address without its language, as URL patterns match it. */
  path: string;
}

/**
 * The language an address is in, and the address without it. With prefixes, "/fr/blog/x"
 * is French and "/blog/x" the default language. With domains, the host decides. A prefix
 * that names no language (or a hidden one) is an ordinary first segment.
 */
export function splitLocalePath(path: string, routing: SiteRouting, locales: readonly string[], defaultLocale: string, host?: string | null): LocalizedPath {
  if (routing.mode === "domains") {
    const bare = (host ?? "").toLowerCase();
    const found = Object.entries(routing.domains).find(([code, domain]) => domain.toLowerCase() === bare && locales.includes(code));
    return { locale: found?.[0] ?? defaultLocale, path };
  }
  if (routing.mode === "none") return { locale: defaultLocale, path };
  const [, first = "", ...rest] = path.split("/");
  const match = locales.find((code) => code.toLowerCase() === first.toLowerCase());
  if (!match) return { locale: defaultLocale, path };
  // With prefixDefault off, "/en/x" isn't the default language's address: it's "/x".
  if (match === defaultLocale && !routing.prefixDefault) return { locale: defaultLocale, path };
  return { locale: match, path: `/${rest.join("/")}`.replace(/\/+$/, "") || "/" };
}

/** A record's address in a language: the pattern's path with the language's prefix, or the language's host. */
export function localizePath(path: string, locale: string, routing: SiteRouting, defaultLocale: string): { path: string; host?: string } {
  if (routing.mode === "domains") return { path, host: routing.domains[locale] };
  if (routing.mode === "none") return { path };
  if (locale === defaultLocale && !routing.prefixDefault) return { path };
  return { path: path === "/" ? `/${locale}` : `/${locale}${path}` };
}

/** `https://fr.example.com/x` with domains, otherwise a path on the current site. */
export function hrefFor(localized: { path: string; host?: string }, secure = true) {
  return localized.host ? `${secure ? "https" : "http"}://${localized.host}${localized.path}` : localized.path;
}
