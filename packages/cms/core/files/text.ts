import "server-only";
import { canonicalLocale } from "../i18n/codes";
import { chainFor, defaultLocale, localeCatalog } from "../i18n/locales";
import { HttpError } from "../http/errors";

/**
 * How a file is described: what an image shows, for a reader who can't see it, and the caption
 * and credit a theme may show with it. The file's own three columns hold the default language's
 * words, and `text` holds the others, so a file needs no row per language. Each of the three
 * falls back on its own along the language chain, as a localized field does.
 */
export interface FileText {
  alt: string;
  caption: string;
  credit: string;
}

export const FILE_TEXT_KEYS = ["alt", "caption", "credit"] as const;
export const EMPTY_FILE_TEXT: FileText = { alt: "", caption: "", credit: "" };

/** Whatever is in the column, read as languages of words. Anything else counts as none. */
export function fileTextOverrides(text: unknown): Record<string, Partial<FileText>> {
  if (!text || typeof text !== "object" || Array.isArray(text)) return {};
  const out: Record<string, Partial<FileText>> = {};
  for (const [locale, value] of Object.entries(text as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const words: Partial<FileText> = {};
    for (const key of FILE_TEXT_KEYS) {
      const word = (value as Record<string, unknown>)[key];
      if (typeof word === "string" && word !== "") words[key] = word;
    }
    if (Object.keys(words).length) out[locale] = words;
  }
  return out;
}

export type TextualFile = { alt: string; caption: string; credit: string; text: unknown };

/** The file's own words, which are the default language's. */
export const ownFileText = (file: TextualFile): FileText => ({ alt: file.alt, caption: file.caption, credit: file.credit });

/**
 * The words to show, given a language and its fallbacks: that language's, then each fallback's,
 * then the file's own. `chain` is the request's language chain, most wanted first.
 */
export function fileTextIn(file: TextualFile, chain: readonly string[] = []): FileText {
  const own = ownFileText(file);
  if (!chain.length) return own;
  const languages = fileTextOverrides(file.text);
  const pick = (key: keyof FileText) => {
    for (const code of chain) {
      const word = languages[code]?.[key];
      if (word) return word;
    }
    return own[key];
  };
  return { alt: pick("alt"), caption: pick("caption"), credit: pick("credit") };
}

/**
 * The columns a write sets. Words for the default language go in the file's own columns, any
 * other language into `text`. An empty string clears that word, and a language left with none
 * is dropped, so turning off a translation falls back rather than showing nothing.
 */
export function fileTextColumns(file: TextualFile, locale: string, primary: string, values: Partial<FileText>) {
  if (locale === primary) {
    const columns: Partial<FileText> = {};
    for (const key of FILE_TEXT_KEYS) if (values[key] !== undefined) columns[key] = values[key];
    return columns;
  }
  const languages = fileTextOverrides(file.text);
  const words = { ...languages[locale] };
  for (const key of FILE_TEXT_KEYS) {
    if (values[key] === undefined) continue;
    if (values[key]) words[key] = values[key];
    else delete words[key];
  }
  if (Object.keys(words).length) languages[locale] = words;
  else delete languages[locale];
  return { text: Object.keys(languages).length ? languages : null };
}

/** The language chain a request reads file text in: the one asked for, else the default language. */
export async function fileTextChain(locale?: string | null) {
  const code = locale || (await defaultLocale());
  return chainFor(code);
}

/**
 * A checked language for a file's text. A hidden language is for staff, as it is for records:
 * here, whoever may describe any file. An unknown or hidden code is refused, so a typo shows up
 * rather than quietly reading the default.
 */
export async function fileTextLocale(raw: string | null | undefined, staff: boolean) {
  const catalog = await localeCatalog();
  if (!raw) return catalog.defaultLocale;
  const code = canonicalLocale(raw);
  if (!code || !catalog.has(code) || (!catalog.isPublic(code) && !staff)) throw new HttpError(400, "INVALID_LOCALE", "This language isn't available.");
  return code;
}
