import { createHash } from "node:crypto";

/** JSON with keys in order, so the same value always hashes the same whatever the database did to key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export const hashValue = (value: unknown) => createHash("sha256").update(stable(value)).digest("base64url").slice(0, 16);

export interface TranslationSource {
  locale: string;
  hashes: Record<string, string>;
}

export function parseSource(raw: unknown): TranslationSource | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as TranslationSource;
    return typeof parsed?.locale === "string" && parsed.hashes && typeof parsed.hashes === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Localized fields whose source value changed after this translation was last saved.
 * A translation saved before its source existed has no hashes, so nothing is outdated.
 */
export function outdatedFields(source: TranslationSource | null, fields: Array<{ id: number; name: string }>, sourceValues: Record<string, unknown>): string[] {
  if (!source) return [];
  return fields.filter((field) => {
    const saved = source.hashes[String(field.id)];
    return saved !== undefined && saved !== hashValue(sourceValues[field.name] ?? null);
  }).map((field) => field.name);
}
