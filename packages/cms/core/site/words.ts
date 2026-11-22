/**
 * The words on a site page, as plain data, so a server component can hand them to a client
 * component as a prop. No server or browser imports.
 */
import { formatters, mergeMessages, messagesFor, type Formatters, type Messages } from "../i18n/messages";
import { hrefFor, localizePath, type SiteRouting } from "../i18n/routing";
import { withBasePath } from "../urls/base-path";

/**
 * A page's language and the words in it: plugins' site words, under each plugin's name,
 * then the theme's, then the owner's changes from Settings → Languages, each winning over
 * the one before key by key. `t("shop.addToCart")` is the Shop plugin's word, unless the
 * theme or the owner words it differently.
 */
export interface SiteWords {
  locale: string;
  messages: Messages;
  /**
   * On a site with more than one language, or one served under a path prefix: the page's
   * language, how addresses carry it, and the prefix. See `sitePath()` and `contentLocale()`.
   */
  site?: { locale: string; defaultLocale: string; routing: SiteRouting; basePath?: string };
}

/** The language plugins write their site words in first, which every other falls back to. */
export const PLUGIN_WORDS_LOCALE = "en";

/** The CMS's own words on site pages, under `cms`, below plugins', themes' and owners'. */
export const TANSY_SITE_MESSAGES: Record<string, Messages> = {
  en: {
    cms: {
      pages: "Pages",
      previous: "Previous",
      next: "Next",
      pageOf: "Page {page} of {total}",
      preview: "Preview. Visitors don't see these changes.",
      exitPreview: "Exit preview",
      missingBlock: "The “{type}” block isn't available in this theme.",
      demo: "This is a demo. Look around the dashboard too: the sign-in is filled in for you.",
      demoDashboard: "Open the dashboard",
    },
  },
  ar: {
    cms: {
      pages: "الصفحات",
      previous: "السابق",
      next: "التالي",
      pageOf: "الصفحة {page} من {total}",
      preview: "معاينة. لا يرى الزوار هذه التغييرات.",
      exitPreview: "إنهاء المعاينة",
      missingBlock: "الكتلة «{type}» غير متاحة في هذا القالب.",
      demo: "هذا عرض تجريبي. تجوّل في لوحة التحكم أيضًا: بيانات الدخول معبّأة لك.",
      demoDashboard: "افتح لوحة التحكم",
    },
  },
};

const ownWords = (locale: string): Messages => messagesFor(TANSY_SITE_MESSAGES, [...new Set([locale, PLUGIN_WORDS_LOCALE])]);

const cache = new WeakMap<SiteWords, Formatters>();

/**
 * `t()`, `formatDate()` and `formatNumber()` for a page's words, in a template, a block or a
 * client component. Without words, only the CMS's own English words are known, so pass the
 * block's or template's `words` whenever there are some.
 */
export function siteWords(words: SiteWords | null | undefined): Formatters {
  if (!words) return formatters(PLUGIN_WORDS_LOCALE, ownWords(PLUGIN_WORDS_LOCALE));
  let found = cache.get(words);
  if (!found) cache.set(words, (found = formatters(words.locale, words.messages)));
  return found;
}

/** Only the named plugins' words, so a client component's props carry no more than it shows: `pickWords(words, "shop")`. */
export function pickWords(words: SiteWords, ...names: string[]): SiteWords {
  const messages = words.messages as Record<string, Messages>;
  const picked = Object.fromEntries(names.filter((name) => Object.hasOwn(messages, name)).map((name) => [name, messages[name]])) as Messages;
  return { locale: words.locale, messages: picked, ...(words.site ? { site: words.site } : {}) };
}

/** The fallback chain for a page in `locale`: its region-free form, the site's default, then the theme's and plugins' own language. */
export function wordsChain(locale: string, siteDefault?: string, themeDefault?: string): string[] {
  return [...new Set([locale, locale.split("-")[0], siteDefault ?? locale, themeDefault ?? PLUGIN_WORDS_LOCALE, PLUGIN_WORDS_LOCALE])];
}

/** The CMS's words, then plugins', then the theme's, then the owner's, each in the page's language with the chain as fallback. */
export function pageWords(locale: string, chain: readonly string[], sources: { plugins?: Record<string, Messages>; theme?: Record<string, Messages>; owner?: Record<string, Messages> }, site?: SiteWords["site"]): SiteWords {
  return { locale, ...(site ? { site } : {}), messages: mergeMessages(messagesFor(TANSY_SITE_MESSAGES, chain), messagesFor(sources.plugins ?? {}, chain), messagesFor(sources.theme ?? {}, chain), messagesFor(sources.owner ?? {}, chain)) };
}

/**
 * A site address in the page's language: "/cart" is "/ar/cart" on an Arabic page. For a
 * client component, which can't take `language.href()` as a prop. On a site with one language,
 * the address as given, unless the site is served under a path prefix, such as one tenant's
 * "/acme", which every address carries.
 */
export function sitePath(words: SiteWords | null | undefined, path: string): string {
  const site = words?.site;
  if (!site) return path;
  return withBasePath(site.basePath, hrefFor(localizePath(path, site.locale, site.routing, site.defaultLocale)));
}

/** The language to read records in, as the records API's `locale`, or undefined on a site with one language. */
export const contentLocale = (words: SiteWords | null | undefined): string | undefined => words?.site?.locale;

/**
 * A plugin's site words in one language, on the server: for an email to a customer in the
 * language they shopped in. `byLanguage` is the plugin's render `messages`, falling back to English.
 */
export function wordsIn(byLanguage: Readonly<Record<string, Messages>>, locale: string | null | undefined): Formatters {
  const code = locale || PLUGIN_WORDS_LOCALE;
  const chain = [...new Set([code, code.split("-")[0], PLUGIN_WORDS_LOCALE])];
  return formatters(code, mergeMessages(messagesFor(TANSY_SITE_MESSAGES, chain), messagesFor(byLanguage, chain)));
}
