/** No server imports: the dashboard and the proxy check codes with this too. */

/** language[-Script][-Region], as Intl writes them. Private-use and extension subtags aren't content languages. */
const SHAPE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;
export const MAX_LOCALE_CODE = 35;
/** A chain longer than this is refused when saved, so a read joins at most this many languages. */
export const MAX_CHAIN = 4;

/** The canonical form of a BCP 47 code, or null when it isn't one a language can have here. */
export function canonicalLocale(code: unknown): string | null {
  if (typeof code !== "string" || !code || code.length > MAX_LOCALE_CODE) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(code);
    return canonical && SHAPE.test(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** "rtl" for Arabic, Hebrew, Persian, Urdu and the rest, from the script Intl infers. */
export function textDirection(code: string): "ltr" | "rtl" {
  try {
    const locale = new Intl.Locale(code) as Intl.Locale & { getTextInfo?: () => { direction: string }; textInfo?: { direction: string } };
    const info = locale.getTextInfo?.() ?? locale.textInfo;
    if (info?.direction === "rtl") return "rtl";
    if (info) return "ltr";
  } catch {
    // Falls through to the list below.
  }
  const script = (() => {
    try {
      return new Intl.Locale(code).maximize().script;
    } catch {
      return undefined;
    }
  })();
  return script && ["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg"].includes(script) ? "rtl" : "ltr";
}

/** A language's own name for itself, such as "Français (Canada)". */
export function nativeName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code;
  } catch {
    return code;
  }
}

export interface LocaleLink {
  code: string;
  fallback: string | null;
}

/**
 * The languages to try for `code`, nearest first, ending at the default. Unknown
 * fallbacks are skipped, and a loop ends the chain, so stored data can never make
 * a read join without limit.
 */
export function fallbackChain(code: string, locales: readonly LocaleLink[], defaultLocale: string): string[] {
  const byCode = new Map(locales.map((locale) => [locale.code, locale]));
  const chain: string[] = [];
  let current: string | null = code;
  while (current && byCode.has(current) && !chain.includes(current) && chain.length < MAX_CHAIN) {
    chain.push(current);
    current = byCode.get(current)!.fallback ?? (current === defaultLocale ? null : defaultLocale);
  }
  if (!chain.includes(defaultLocale) && byCode.has(defaultLocale)) {
    if (chain.length === MAX_CHAIN) chain[MAX_CHAIN - 1] = defaultLocale;
    else chain.push(defaultLocale);
  }
  return chain;
}

/** Why this set of fallbacks can't be saved, or null. */
export function chainProblem(locales: readonly LocaleLink[], defaultLocale: string): string | null {
  const byCode = new Map(locales.map((locale) => [locale.code, locale]));
  for (const locale of locales) {
    if (locale.fallback === null) continue;
    if (locale.fallback === locale.code) return `${locale.code} can't fall back to itself.`;
    if (!byCode.has(locale.fallback)) return `${locale.code} falls back to ${locale.fallback}, which isn't a language here.`;
    const seen = [locale.code];
    let current: string | null = locale.fallback;
    while (current) {
      if (seen.includes(current)) return `${locale.code}'s fallbacks go round in a loop.`;
      seen.push(current);
      current = byCode.get(current)?.fallback ?? null;
    }
    const length = seen.length + (seen.includes(defaultLocale) ? 0 : 1);
    if (length > MAX_CHAIN) return `${locale.code}'s fallbacks are longer than ${MAX_CHAIN} languages.`;
  }
  return null;
}

/**
 * The best supported language for an Accept-Language header, by RFC 4647 lookup:
 * each range in order of quality, then shorter forms of it ("fr-CA" then "fr").
 */
export function negotiateLocale(header: string | null | undefined, supported: readonly string[]): string | null {
  if (!header) return null;
  const ranges = header.split(",").slice(0, 32).flatMap((part, index) => {
    const [range, ...params] = part.trim().split(";");
    const q = params.map((param) => /^\s*q=([01](\.\d{0,3})?)\s*$/.exec(param)?.[1]).find(Boolean);
    const quality = q === undefined ? 1 : Number(q);
    return range && range !== "*" && quality > 0 ? [{ range: range.trim().toLowerCase(), quality, index }] : [];
  }).sort((a, b) => b.quality - a.quality || a.index - b.index);
  const lower = new Map(supported.map((code) => [code.toLowerCase(), code]));
  for (const { range } of ranges) {
    const parts = range.split("-");
    while (parts.length) {
      const found = lower.get(parts.join("-"));
      if (found) return found;
      parts.pop();
    }
  }
  return null;
}
