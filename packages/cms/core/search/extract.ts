import type { Block } from "../blocks/limits";
import { searchableText } from "../fields/registry";

interface SearchField { name: string; type: string; config?: unknown }
export type SearchCatalog = Map<string, { fields: SearchField[] }>;

const MAX_TEXT = 200_000;
const MAX_DEPTH = 12;

const optionsOf = (field: SearchField) => (field.config ?? {}) as { searchable?: boolean; hidden?: boolean };

/** A hidden field is never indexed, or searching would let people probe its value. */
export const isIndexed = (field: SearchField) => optionsOf(field).searchable === true && optionsOf(field).hidden !== true;

/** Changes when a reindex is needed, including when a field moves between shared and localized. */
export const searchSignature = (fields: SearchField[]) => JSON.stringify(fields.filter(isIndexed).map((field) => [field.name, field.type, (field.config as { localized?: boolean } | null)?.localized === true]));

function collect(field: SearchField, value: unknown, catalog: SearchCatalog, out: string[], depth: number) {
  if (value === null || value === undefined || depth > MAX_DEPTH) return;
  if (field.type !== "stream") {
    out.push(...searchableText(field, value));
    return;
  }
  if (!Array.isArray(value)) return;
  for (const block of value as Block[]) {
    for (const inner of catalog.get(block.type)?.fields ?? []) collect(inner, block.value?.[inner.name], catalog, out, depth + 1);
  }
}

/** Every searchable word in a record, including inside blocks. */
export function searchText(fields: SearchField[], row: Record<string, unknown>, catalog: SearchCatalog): string {
  const out: string[] = [];
  for (const field of fields.filter(isIndexed)) collect(field, row[field.name], catalog, out, 0);
  return out.join("\n").slice(0, MAX_TEXT);
}

/** Letters and digits only, so nothing a caller types can be read as query syntax. */
export const searchWords = (raw: string) => (raw.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 20);

/** The last word matches as a prefix, so results appear while typing. */
export const sqliteQuery = (words: string[]) => words.map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`).join(" ");
export const postgresQuery = (words: string[]) => words.map((word, index) => `${word}${index === words.length - 1 ? ":*" : ""}`).join(" & ");
