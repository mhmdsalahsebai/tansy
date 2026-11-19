import "server-only";
import { holdsRecordPermissionForSome } from "../authz/permissions";
import type { Principal } from "../authz/principal";
import { HttpError } from "../http/errors";
import { canonicalLocale } from "./codes";
import { localizationOf, type CollectionLocale } from "./context";
import { localeCatalog, type LocaleCatalog } from "./locales";
import { anyLocale, readLocale, withLocale, writeLocale } from "./storage";

export interface LocaleParams {
  locale?: string | null;
  fallback?: string | null;
}

/** `?locale=` and `?fallback=` from a request's address, which every record route accepts, writes included. */
export function localeParams(request: { nextUrl?: URL; url: string }): LocaleParams {
  const params = (request.nextUrl ?? new URL(request.url)).searchParams;
  return { locale: params.get("locale"), fallback: params.get("fallback") };
}

const invalidLocale = () => new HttpError(400, "INVALID_LOCALE", "This language isn't available.");

/**
 * Hidden languages are for staff: someone who may read every record of the collection
 * through their role. To anyone else a hidden language is the same as an unknown one.
 */
function mayUse(catalog: LocaleCatalog, code: string, principal: Principal, collectionId: number) {
  if (!catalog.has(code)) return false;
  return catalog.isPublic(code) || holdsRecordPermissionForSome(principal.permissions, "record:read", collectionId);
}

/** A checked language code from a request, or the default when it named none. */
export function requestedLocale(catalog: LocaleCatalog, raw: string | null | undefined, principal: Principal, collectionId: number) {
  if (raw === null || raw === undefined || raw === "") return catalog.defaultLocale;
  const code = canonicalLocale(raw);
  if (!code || !mayUse(catalog, code, principal, collectionId)) throw invalidLocale();
  return code;
}

export interface ReadingLocale<C> {
  collection: C & { locale?: CollectionLocale };
  /** The language asked for, for `@request.locale`. Undefined for a collection that isn't localized. */
  locale?: string;
  /** `?locale=*`: every language the caller may see, each field as a map. */
  all: boolean;
}

/**
 * Attaches the language a read uses. A collection that isn't localized ignores the
 * parameter, so a site can send it to every collection, but an unknown code is still
 * refused, so a typo shows up rather than reading the default.
 */
export async function readingLocale<C extends { id: number; localization?: unknown }>(collection: C, principal: Principal, params: LocaleParams): Promise<ReadingLocale<C>> {
  const catalog = await localeCatalog();
  if (params.fallback && params.fallback !== "none" && params.fallback !== "chain") throw new HttpError(400, "INVALID_FALLBACK", 'fallback must be "none" or "chain".');
  if (params.locale === "*") {
    if (!localizationOf(collection)) return { collection, all: false };
    return { collection: withLocale(collection, anyLocale(catalog)), locale: catalog.defaultLocale, all: true };
  }
  const code = requestedLocale(catalog, params.locale, principal, collection.id);
  if (!localizationOf(collection)) return { collection, all: false };
  return { collection: withLocale(collection, readLocale(collection, catalog, code, params.fallback === "none" ? "none" : undefined)), locale: code, all: false };
}

/** Attaches the language a write goes to. Its translation reads empty if it doesn't exist yet. */
export async function writingLocale<C extends { id: number; localization?: unknown }>(collection: C, principal: Principal, params: LocaleParams): Promise<{ collection: C & { locale?: CollectionLocale }; locale?: string }> {
  if (params.locale === "*") throw invalidLocale();
  const catalog = await localeCatalog();
  const code = requestedLocale(catalog, params.locale, principal, collection.id);
  if (!localizationOf(collection)) return { collection };
  return { collection: withLocale(collection, writeLocale(code)), locale: code };
}

/** Every collection in the same language, for expansion: linked records are read as the parent is. */
export async function inLocale<C extends { localization?: unknown }>(collections: C[], code: string | undefined, fallback?: "none") {
  if (!code) return collections;
  const catalog = await localeCatalog();
  return collections.map((collection) => withLocale(collection, readLocale(collection, catalog, code, fallback)));
}
