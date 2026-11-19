import { SYSTEM_RECORD_FIELDS } from "../authz/rules/evaluate";

const MAX_IDENTIFIER = 63;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// "expand" holds related records in API responses.
// "locale" names the language a localized record was read in.
const RESERVED = new Set([...SYSTEM_RECORD_FIELDS, "rowid", "oid", "expand", "locale"].map((name) => name.toLowerCase()));

/** Field names are column names and rule identifiers, so both sets of limits apply. */
export function fieldNameProblem(name: string): string | null {
  if (!FIELD_NAME.test(name)) return "Use letters, numbers and underscores, starting with a letter.";
  if (name.length > MAX_IDENTIFIER) return `Must be at most ${MAX_IDENTIFIER} characters.`;
  if (RESERVED.has(name.toLowerCase())) return "This name is reserved for a system field.";
  return null;
}

/** Slugs can't contain underscores, so this never collides. The prefix keeps record tables apart from system tables. */
export const tableName = (slug: string) => `rec_${slug.replaceAll("-", "_")}`;

/** A localized collection's translations. A different prefix, so it can't collide with a record table either. */
export const localeTableName = (slug: string) => `loc_${slug.replaceAll("-", "_")}`;

export const SLUG_MAX = MAX_IDENTIFIER;
