/**
 * ICU messages, for themes' words and the dashboard's. A thin layer over use-intl, so
 * themes and plugins depend on this and the library can change underneath them.
 * No server or browser imports: it runs in server components, client components and
 * headless sites alike.
 */
import { parse } from "@formatjs/icu-messageformat-parser";
import { createFormatter, createTranslator, type AbstractIntlMessages } from "use-intl/core";

/** Messages by key, nested as `{ blog: { readMore: "Read more" } }`, in ICU MessageFormat. */
export type Messages = AbstractIntlMessages;
export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

/** Looks a message up by its dotted key. A missing or broken message shows its key, so a page never fails over a word. */
export type Translate = (key: string, values?: MessageValues) => string;

export interface Formatters {
  t: Translate;
  formatDate(value: Date | string | number, style?: "short" | "medium" | "long"): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatList(items: string[], type?: "conjunction" | "disjunction"): string;
  formatRelative(value: Date | string | number, now?: Date): string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Later sources win, key by key, so an owner's override replaces one word and keeps the rest. */
export function mergeMessages(...sources: Array<Messages | undefined | null>): Messages {
  const out: Record<string, unknown> = {};
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = isObject(value) && isObject(out[key]) ? mergeMessages(out[key] as Messages, value as Messages) : value;
    }
  }
  return out as Messages;
}

/**
 * Catalogs by language, merged language by language with later sources winning key by key.
 * For a plugin whose provider packages ship their own words, such as each payment
 * provider's settings: `messages: mergeMessagesByLanguage(own, ...providers.map((p) => p.messages))`.
 */
export function mergeMessagesByLanguage(...sources: Array<Readonly<Record<string, Messages>> | undefined | null>): Record<string, Messages> {
  const codes = new Set(sources.flatMap((source) => Object.keys(source ?? {})));
  return Object.fromEntries([...codes].map((code) => [code, mergeMessages(...sources.map((source) => (source && Object.hasOwn(source, code) ? source[code] : undefined)))]));
}

/**
 * The messages for a language, walking its chain: `fr-CA` falls back to `fr`, then to
 * the default language, key by key. `byLocale` holds each language's catalog.
 */
export function messagesFor(byLocale: Readonly<Record<string, Messages | undefined>>, chain: readonly string[]): Messages {
  return mergeMessages(...[...chain].reverse().map((code) => (Object.hasOwn(byLocale, code) ? byLocale[code] : undefined)));
}

const toDate = (value: Date | string | number) => (value instanceof Date ? value : new Date(value));

/** `t()` and the `Intl` formatters for one language. */
export function formatters(locale: string, messages: Messages, timeZone = "UTC"): Formatters {
  const translate = createTranslator({
    locale,
    messages,
    timeZone,
    onError: () => {},
    getMessageFallback: ({ key, namespace }) => (namespace ? `${namespace}.${key}` : key),
  });
  const format = createFormatter({ locale, timeZone, onError: () => {} });
  return {
    t: (key, values) => {
      try {
        // use-intl types keys from a declared catalog. Here they come from a theme, so they're strings.
        return (translate as unknown as (key: string, values?: MessageValues) => string)(key, values);
      } catch {
        return key;
      }
    },
    formatDate: (value, style = "medium") => {
      const date = toDate(value);
      return Number.isNaN(date.getTime()) ? "" : format.dateTime(date, { dateStyle: style });
    },
    formatNumber: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    formatList: (items, type = "conjunction") => format.list(items, { type }),
    formatRelative: (value, now) => {
      const date = toDate(value);
      return Number.isNaN(date.getTime()) ? "" : format.relativeTime(date, now ?? new Date());
    },
  };
}

/**
 * A word a plugin registered in code, such as a page's title or a setting's label, in the
 * interface language: its `messages` entry under `ext.<plugin>.<key>`, else as registered.
 * The keys are listed in docs/EXTENDING.md.
 */
export function pluginWord(t: Translate, plugin: string, key: string, fallback: string): string {
  const full = `ext.${plugin}.${key}`;
  const text = t(full);
  return text === full ? fallback : text;
}

/**
 * Problems in a catalog: keys whose text isn't valid ICU, and keys with dots, which
 * lookups read as nesting. Checked when owners save site text, and in CI for the
 * dashboard's catalogs. Parsed directly, because use-intl's production build doesn't
 * report a broken message.
 */
export function messageProblems(messages: Messages, prefix = ""): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key.includes(".")) problems.push(`${path}: keys can't contain dots.`);
    else if (typeof value === "string") {
      try {
        parse(value);
      } catch (error) {
        problems.push(`${path}: ${(error as Error).message}`);
      }
    } else if (isObject(value)) problems.push(...messageProblems(value as Messages, path));
    else problems.push(`${path}: must be a string or a group of messages.`);
  }
  return problems;
}
