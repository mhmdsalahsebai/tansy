import "server-only";
import { decideRecord, loadRuleLookups, type RuleRequest } from "../authz/records";
import type { Principal } from "../authz/principal";
import type { CollectionWithFields } from "../content/access";
import { findRecordsById } from "../content/content-service";
import { flattenRecord, readableFields } from "../content/records";
import { localizedFields, localizationOf, type EditorLocalization } from "./context";
import { localeCatalog } from "./locales";
import { outdatedFields, parseSource } from "./outdated";
import { editableLocales } from "./permissions";
import { translationsOf, withLocale } from "./storage";

export type { EditorLocalization };

/**
 * What the record editor shows about languages. Reads only what the person could read
 * through the API: the source values pass the view rule in the default language, and
 * fields they can't read stay out.
 */
export async function editorLocalization(collection: CollectionWithFields, recordId: number | null, code: string, principal: Principal, request: RuleRequest): Promise<EditorLocalization | null> {
  if (!localizationOf(collection)) return null;
  const catalog = await localeCatalog();
  const base = {
    locale: code,
    defaultLocale: catalog.defaultLocale,
    locales: catalog.locales.map(({ code: value, label, direction, public: isPublic }) => ({ code: value, label, direction, public: isPublic })),
    editable: editableLocales(principal.permissions),
  };
  if (recordId === null) return { ...base, translations: [], source: null };

  const fields = localizedFields(collection);
  const sourceIn = withLocale(collection, { code: catalog.defaultLocale, chain: [catalog.defaultLocale], missing: "absent" });
  const [sourceRow] = await findRecordsById(sourceIn, [recordId]);
  const req = { ...request, lookups: request.lookups ?? (await loadRuleLookups([collection])), locale: catalog.defaultLocale };
  const readableSource = sourceRow && decideRecord(principal, sourceIn, "view", flattenRecord(sourceRow), req) === "allow" ? sourceRow : null;
  const readable = new Set(readableFields(collection, principal, readableSource ?? undefined).map((field) => field.name));
  const sourceValues = readableSource ? Object.fromEntries(fields.filter((field) => readable.has(field.name)).map((field) => [field.name, readableSource[field.name] ?? null])) : null;

  const translations = (await translationsOf(collection, recordId))
    .filter((translation) => catalog.has(translation.locale))
    .map(({ locale, status, updatedAt, source }) => ({
      locale,
      status,
      updatedAt,
      // Without the source the person can read, nothing can be compared.
      outdated: locale === catalog.defaultLocale || !readableSource ? [] : outdatedFields(parseSource(source), fields, readableSource).filter((name) => readable.has(name)),
    }));
  return { ...base, translations, source: code !== catalog.defaultLocale && sourceValues ? { locale: catalog.defaultLocale, values: sourceValues } : null };
}
