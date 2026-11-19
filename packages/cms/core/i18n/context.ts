/** No server imports: the dashboard decides which fields are shared with this too. */

export interface LocalizationConfig {
  enabled: boolean;
  /** "chain" tries the language's fallbacks. "none" means a record with no translation in a language doesn't exist in it. */
  fallback: "chain" | "none";
  /** Fills an empty localized field from the next published language in the chain. */
  fieldFallback: boolean;
}

/**
 * Which languages a read or write of a localized collection uses. Travels on the
 * collection object, so every function that already takes a collection carries it.
 */
export interface CollectionLocale {
  /** The language asked for, and the one a write goes to. */
  code: string;
  /** Languages to read, nearest first. The first with a published translation wins, otherwise the first with any. */
  chain: string[];
  /** "empty": a record with no translation in `code` reads with empty localized values, for writing one. */
  missing: "absent" | "empty";
}

interface CollectionShape {
  localization?: unknown;
  fields: ReadonlyArray<{ name: string; config: unknown }>;
}

export type WithLocale<C> = C & { locale?: CollectionLocale };

export function localizationOf(collection: { localization?: unknown }): LocalizationConfig | null {
  const value = collection.localization as Partial<LocalizationConfig> | null | undefined;
  if (!value || value.enabled !== true) return null;
  return { enabled: true, fallback: value.fallback === "none" ? "none" : "chain", fieldFallback: value.fieldFallback === true };
}

export const isLocalizedCollection = (collection: { localization?: unknown }) => localizationOf(collection) !== null;

/** Marked localized in a collection that has localization turned on. */
export function isLocalizedField(collection: { localization?: unknown }, field: { config: unknown }) {
  return isLocalizedCollection(collection) && (field.config as { localized?: boolean } | null)?.localized === true;
}

export const localizedFields = <C extends CollectionShape>(collection: C) => collection.fields.filter((field) => isLocalizedField(collection, field)) as C["fields"][number][];
export const sharedFields = <C extends CollectionShape>(collection: C) => collection.fields.filter((field) => !isLocalizedField(collection, field)) as C["fields"][number][];

/** The language a link or file use belongs to: the written language for a localized field, "" for a shared one. */
export const refLocale = (collection: WithLocale<{ localization?: unknown }>, field: { config: unknown }, code: string | undefined) =>
  isLocalizedField(collection, field) && code ? code : "";

/** What the record editor shows about languages, from the content API. */
export interface EditorLocalization {
  /** The language the editor has open. */
  locale: string;
  defaultLocale: string;
  locales: Array<{ code: string; label: string; direction: "ltr" | "rtl"; public: boolean }>;
  /** Languages this person may write in. Null means every one. */
  editable: string[] | null;
  /** Each language the record has, with its status and the fields changed in the default language since it was last saved. */
  translations: Array<{ locale: string; status: string; updatedAt: string; outdated: string[] }>;
  /** The default language's localized values, to show beside a translation. Null in the default language, or when that translation can't be read. */
  source: { locale: string; values: Record<string, unknown> } | null;
}
