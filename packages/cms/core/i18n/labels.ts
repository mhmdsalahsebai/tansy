/**
 * Names in the dashboard's interface languages: a collection's name, a block's label or a
 * field's label, given per language as `{ ar: "المقالات" }` beside the plain one, which
 * covers any language missing. No imports, so client components use it too.
 */
export type Labels = Record<string, string>;

/** One language's entry, falling back from "ar-EG" to "ar". Undefined when there's none. */
export function pickLabel(labels: unknown, locale: string): string | undefined {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return undefined;
  const entries = labels as Record<string, unknown>;
  const found = (Object.hasOwn(entries, locale) ? entries[locale] : undefined) ?? (Object.hasOwn(entries, locale.split("-")[0]) ? entries[locale.split("-")[0]] : undefined);
  return typeof found === "string" && found.trim() ? found : undefined;
}

/** The name to show in an interface language. */
export const labelIn = (item: { labels?: unknown }, plain: string, locale: string) => pickLabel(item.labels, locale) ?? plain;

/** Without empty entries, and null when nothing is left, so "no names" is stored one way. */
export function cleanLabels(labels: Labels | null | undefined): Labels | null {
  const kept = Object.entries(labels ?? {}).map(([code, text]) => [code, text.trim()] as const).filter(([, text]) => text);
  return kept.length ? Object.fromEntries(kept) : null;
}
