import "server-only";
import prisma from "../../lib/prisma";
import type { Principal } from "../authz/principal";
import { loadRuleLookups, type RuleRequest } from "../authz/records";
import type { CollectionWithFields } from "../content/access";
import { findRecordAt, findRecordsById } from "../content/content-service";
import { viewRecord } from "../content/public-records";
import type { RecordViewQuery } from "../content/query";
import { flattenRecord, type RecordRow } from "../content/records";
import { HttpError } from "../http/errors";
import { canonicalLocale } from "../i18n/codes";
import { isLocalizedCollection } from "../i18n/context";
import { localeCatalog, localizationSettings, type LocaleCatalog } from "../i18n/locales";
import { hrefFor, localizePath, splitLocalePath } from "../i18n/routing";
import { readLocale, withLocale } from "../i18n/storage";
import type { ResolvedAddress } from "../site/page";
import type { SiteRecord } from "../theme/define";
import { normalizePath } from "./path";
import { siteHref } from "./site-href";
import { buildRecordPath, comparePatterns, insideCms, matchPattern, type PathMatch } from "./pattern";
import { findRedirect } from "./redirects";
import { currentScope } from "../scope/context";

export interface UrlCandidate {
  collection: CollectionWithFields;
  match: PathMatch;
}

/** Every collection whose pattern fits this normalized path, most specific first. Nothing here says a record exists or may be seen. */
export async function urlCandidates(path: string): Promise<UrlCandidate[]> {
  // Work for no scope value, such as a site on a host no tenant has, has no scoped records, so their addresses aren't its.
  const state = currentScope();
  const withoutScope = state?.kind === "value" && state.value === null;
  const collections = await prisma.collection.findMany({ where: { urlPattern: { not: null }, ...(withoutScope ? { scoped: false } : {}) }, include: { fields: { orderBy: { id: "asc" } } } });
  return collections
    .sort((a, b) => comparePatterns(a.urlPattern!, b.urlPattern!))
    .flatMap((collection) => {
      const match = matchPattern(collection.urlPattern!, path);
      return match ? [{ collection, match }] : [];
    });
}

export interface ResolveOptions {
  /** The language to read the address in, `path` then being the address without its prefix. Without it, the prefix or `host` decides. */
  locale?: string | null;
  /** The request's host, for sites with a domain per language. */
  host?: string | null;
}

type CanView = (collection: CollectionWithFields, record: Record<string, unknown>, request: RuleRequest) => boolean;

/** Only public languages have addresses. A hidden one is as unknown as a typo. */
function addressLocale(catalog: LocaleCatalog, raw: string) {
  const code = canonicalLocale(raw);
  if (!code || !catalog.isPublic(code)) throw new HttpError(400, "INVALID_LOCALE", "This language isn't available.");
  return code;
}

/** Reads one language only: the record's translation in it, or nothing. */
const onlyIn = (collection: CollectionWithFields, code: string) => withLocale(collection, { code, chain: [code], missing: "absent" });

/**
 * Turns a site address into a record or a redirect, for the HTTP API and same-app sites
 * alike. A record the caller can't view is treated as absent, whichever way the rule
 * refuses, so the answer is the same as for an address that never existed.
 *
 * On a site with more than one public language, the address's prefix or host picks the
 * language, and localized collections match that language's values: a French slug under
 * /fr. A record found under another language's values is a redirect to its address in
 * this language, and only when the caller can view it in both, so an address can't be
 * used to learn about a translation the caller couldn't read.
 */
export async function resolveAddress(requested: string, view: RecordViewQuery, principal: Principal, request: (lookups: RuleRequest["lookups"]) => RuleRequest, canView: CanView, options: ResolveOptions = {}): Promise<ResolvedAddress | null> {
  const fullPath = normalizePath(requested);
  if (fullPath === null || insideCms(fullPath)) return null;

  const [catalog, settings] = await Promise.all([localeCatalog(), localizationSettings()]);
  const publicCodes = catalog.locales.filter((locale) => locale.public).map((locale) => locale.code);
  const multilingual = publicCodes.length > 1;
  let code = catalog.defaultLocale;
  let path = fullPath;
  if (options.locale) code = addressLocale(catalog, options.locale);
  else if (multilingual) ({ locale: code, path } = splitLocalePath(fullPath, settings.routing, publicCodes, catalog.defaultLocale, options.host));
  // Addresses are matched and compared without the scope value's path prefix, and carry it on the way out.
  const addressIn = (target: string, locale: string) => hrefFor(localizePath(target, locale, settings.routing, catalog.defaultLocale));

  const candidates = await urlCandidates(path);
  const base = request(await loadRuleLookups(candidates.map(({ collection }) => collection)));
  const req: RuleRequest = { ...base, locale: code };
  const reading = (collection: CollectionWithFields) => withLocale(collection, readLocale(collection, catalog, code, view.fallback));

  for (const { collection, match } of candidates) {
    const source = reading(collection);
    const row = await findRecordAt(source, match);
    if (row && canView(source, flattenRecord(row), req)) {
      const record = await viewRecord(source, row, view, principal, req) as SiteRecord;
      if (!multilingual) return { type: "record", collection: collection.slug, path: fullPath, record };
      return { type: "record", collection: collection.slug, path: fullPath, record, locale: code, alternates: await alternatesOf(collection, row, publicCodes, base, canView, addressIn) };
    }
  }

  if (multilingual) {
    const moved = await translatedAddress(candidates, code, publicCodes, req, base, canView, reading, addressIn);
    if (moved && moved !== fullPath) return { type: "redirect", to: siteHref(moved), status: 302 };
  }

  // Redirects compare whole addresses, language prefix included.
  const redirect = await findRedirect(fullPath);
  // Redirects are stored as plain site addresses, so the prefix goes back on the way out.
  return redirect ? { type: "redirect", to: siteHref(redirect.to), status: redirect.status } : null;
}

/** The record's address in each public language it can be viewed in. A shared collection has the same values in every one. */
async function alternatesOf(collection: CollectionWithFields, row: RecordRow, codes: string[], base: RuleRequest, canView: CanView, addressIn: (path: string, locale: string) => string) {
  const alternates: Record<string, string> = {};
  for (const code of codes) {
    let translation: RecordRow | undefined = row;
    let source = collection;
    if (isLocalizedCollection(collection)) {
      source = onlyIn(collection, code);
      [translation] = await findRecordsById(source, [row.id]);
    }
    if (!translation || !canView(source, flattenRecord(translation), { ...base, locale: code })) continue;
    const path = buildRecordPath(collection.urlPattern!, translation);
    if (path) alternates[code] = siteHref(addressIn(path, code));
  }
  return alternates;
}

/**
 * An address written with another language's values, such as the English slug under /fr:
 * the same record's address in this language. Null unless the caller may view the record
 * in the language whose values matched and in this one.
 */
async function translatedAddress(candidates: UrlCandidate[], code: string, codes: string[], req: RuleRequest, base: RuleRequest, canView: CanView, reading: (collection: CollectionWithFields) => CollectionWithFields, addressIn: (path: string, locale: string) => string) {
  for (const { collection, match } of candidates) {
    if (!isLocalizedCollection(collection)) continue;
    for (const other of codes) {
      if (other === code) continue;
      const there = onlyIn(collection, other);
      const found = await findRecordAt(there, match);
      if (!found || !canView(there, flattenRecord(found), { ...base, locale: other })) continue;
      const here = reading(collection);
      const [row] = await findRecordsById(here, [found.id]);
      if (!row || !canView(here, flattenRecord(row), req)) continue;
      const path = buildRecordPath(collection.urlPattern!, row);
      return path ? addressIn(path, code) : null;
    }
  }
  return null;
}
