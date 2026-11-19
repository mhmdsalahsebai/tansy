import "server-only";
import { headers } from "next/headers";
import type { CmsConfig } from "../auth/extensions";
import { loadBranding } from "../auth/branding";
import { requestAllowed } from "../auth/extension-hooks";
import { getRuntime } from "../auth/instance";
import { ANONYMOUS, memberPrincipal, principalFromSession, type Principal } from "../authz/principal";
import { decideRecord, type RuleRequest } from "../authz/records";
import { provideCmsConfig } from "../config";
import { recordViewQuery } from "../content/query";
import { scopedRecords } from "../extend/records";
import { HttpError } from "../http/errors";
import { clientIp } from "../http/request";
import { apiPath } from "../../lib/paths";
import type { SiteList, SiteRecord } from "../theme/define";
import { resolveAddress } from "../urls/resolve";
import { localeCatalog, localizationSettings } from "../i18n/locales";
import { cachedRead as cachedAnyRead } from "./cache";
import { currentScopeValue } from "../scope/context";
import { EMPTY_LIST, type EveryPageInfo, type SiteLocalization, type SiteReader } from "./page";
import { loadPreview, type PreviewCheck } from "./preview";
import { layerIdentity, readSiteIdentity } from "./identity";

const canIssuerView: PreviewCheck = (issuer, collection, record, request) => decideRecord(issuer, collection, "view", record, request) === "allow";

/**
 * A locked rule or an unknown collection reads as empty, as it would to a visitor, rather than
 * taking the page down. So does a scoped collection on a page that has no scope value, such as
 * a site on a host no tenant has: it has no records there.
 */
const absent = (error: unknown) => error instanceof HttpError && (error.status === 403 || error.status === 404 || error.code === "SCOPE_REQUIRED");

/** Each scope value, such as a tenant's site, gets its own answers. */
const cachedRead = <T>(parts: unknown[], load: () => Promise<T>) => cachedAnyRead([currentScopeValue(), ...parts], load);

async function orElse<T>(read: Promise<T>, fallback: T) {
  try {
    return await read;
  } catch (error) {
    if (absent(error)) return fallback;
    throw error;
  }
}

/** The public languages, as `GET /api/locales` gives them to a headless site. */
async function siteLocalization(): Promise<SiteLocalization> {
  const [catalog, settings] = await Promise.all([localeCatalog(), localizationSettings()]);
  const items = catalog.locales.filter((locale) => locale.public);
  return {
    defaultLocale: catalog.defaultLocale,
    routing: { mode: settings.routing.mode, prefixDefault: settings.routing.prefixDefault, domains: settings.routing.domains },
    items: items.map(({ code, label, direction }) => ({ code, label, direction })),
    messages: Object.fromEntries(Object.entries(settings.siteText).filter(([code]) => items.some((item) => item.code === code))),
  };
}

/** Rule-checked reads as `principal`, with nothing cached: what one member reads is theirs alone. */
function memberReader(principal: Principal, base: Pick<SiteReader, "branding" | "preview" | "fileUrl" | "localization">): SiteReader {
  const records = scopedRecords(principal);
  const ruleRequest = (path: string) => (lookups: RuleRequest["lookups"]): RuleRequest => ({ method: "GET", headers: new Headers(), query: { path }, body: {}, lookups });
  const list = (slug: string, options: Record<string, unknown> = {}) => orElse(records.list(slug, options) as Promise<SiteList>, EMPTY_LIST);
  return {
    ...base,
    list,
    get: (slug, id, options = {}) => orElse(records.get(slug, id, options) as Promise<SiteRecord>, null),
    singleton: async (slug, options = {}) => (await list(slug, { ...options, perPage: 1 })).items[0] ?? null,
    resolve: (path, options = {}) => resolveAddress(path, recordViewQuery.parse(options), principal, ruleRequest(path), (collection, record, request) => decideRecord(principal, collection, "view", record, request) === "allow", options),
  };
}

/** The signed-in person behind this request, as a member of the site, or null. Extensions' request guards can refuse, which reads as signed out. */
async function currentMember(): Promise<Principal | null> {
  const requestHeaders = await headers();
  const runtime = await getRuntime();
  const member = memberPrincipal(await principalFromSession(requestHeaders, runtime));
  if (!member) return null;
  const allowed = await requestAllowed({ surface: "page", principal: member, ip: clientIp(requestHeaders, runtime.settings), method: "GET", path: requestHeaders.get("x-pathname") ?? "/", headers: requestHeaders });
  return allowed ? member : null;
}

/** Long enough for a settings read, short enough that a slow plugin can't hold up every page. */
const EVERY_PAGE_TIMEOUT_MS = 2_000;
/** Props reach the browser in the page, so they stay small. */
const EVERY_PAGE_MAX_BYTES = 16 * 1024;

/**
 * Each plugin's props for its components on every page. A function that throws, takes too
 * long or returns something that isn't small JSON leaves its component off, logged, and
 * never takes the page down. Props are copied through JSON, so only data reaches the browser.
 */
export async function everyPageProps(config: CmsConfig, page: EveryPageInfo): Promise<Record<string, unknown>> {
  const parts = (config.plugins ?? []).flatMap((plugin) => Object.entries(plugin.everyPage ?? {}).map(([name, props]) => ({ plugin: plugin.name, name, props })));
  if (!parts.length) return {};
  const { extensionContext } = await import("../extend/hooks");
  const results = await Promise.all(parts.map(async ({ plugin, name, props }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), EVERY_PAGE_TIMEOUT_MS); });
      const value = await Promise.race([Promise.resolve(props({ ...extensionContext(`plugin:${plugin}`), page: { ...page } })), timeout]);
      if (value === null || value === undefined) return null;
      const text = JSON.stringify(value);
      if (text === undefined || Buffer.byteLength(text) > EVERY_PAGE_MAX_BYTES) throw new Error(`props must be JSON of at most ${EVERY_PAGE_MAX_BYTES} bytes`);
      return [name, JSON.parse(text)] as const;
    } catch (error) {
      console.error(`[site] ${plugin}: everyPage "${name}" failed, so it's left off the page`, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
}

/**
 * Rule-checked reads for a site in the same app as the CMS. Everything runs as a
 * signed-out visitor, through the same code as the HTTP API, and there's deliberately
 * no way to reach `system`. Only `viewer()` reads as someone: the signed-in person
 * making the request, with API rules alone deciding, never their role's permissions.
 */
export function createSite(config: CmsConfig): SiteReader {
  provideCmsConfig(config);
  const records = scopedRecords(ANONYMOUS);

  const list = (slug: string, options: Record<string, unknown> = {}) =>
    cachedRead(["list", slug, options], () => orElse(records.list(slug, options) as Promise<SiteList>, EMPTY_LIST));

  const shared: Pick<SiteReader, "branding" | "preview" | "fileUrl" | "localization"> = {
    // Cached in process by the language registry, and cleared with the site cache when languages change.
    localization: siteLocalization,
    // A scope value's own name, logo and colour, such as a tenant's, over the instance's.
    branding: async () => layerIdentity(await loadBranding(), await readSiteIdentity()),
    // Unpublished content, so never cached.
    preview: (token) => loadPreview(token, canIssuerView),
    fileUrl: (id, thumb) => apiPath(`/files/${encodeURIComponent(id)}${thumb ? `?thumb=${thumb}` : ""}`),
  };

  return {
    ...shared,
    list,
    get: (slug, id, options = {}) => cachedRead(["get", slug, id, options], () => orElse(records.get(slug, id, options) as Promise<SiteRecord>, null)),
    singleton: async (slug, options = {}) => (await list(slug, { ...options, perPage: 1 })).items[0] ?? null,
    // The language is part of the key, so each language's answer is cached apart.
    resolve: (path, options = {}) => cachedRead(["resolve", path, options.locale ?? null], () => resolveAddress(path, recordViewQuery.parse(options), ANONYMOUS, (lookups) => ({ method: "GET", headers: new Headers(), query: { path }, body: {}, lookups }), (collection, record, request) => decideRecord(ANONYMOUS, collection, "view", record, request) === "allow", options)),
    viewer: async () => {
      const member = await currentMember();
      return member ? memberReader(member, shared) : null;
    },
    everyPage: (page) => everyPageProps(config, page),
  };
}
