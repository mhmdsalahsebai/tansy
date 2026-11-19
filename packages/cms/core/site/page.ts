import type { Renderers } from "../../components/stream/StreamField";
import { withBasePath } from "../urls/base-path";
import { normalizePath } from "../urls/path";
import { bindRecordFilter } from "./filter";
import { formatters, type Messages } from "../i18n/messages";
import { hrefFor, localizePath, splitLocalePath, type SiteRouting } from "../i18n/routing";
import { NO_FILE_FOCUS, NO_FILE_TEXT, type FileFocus, type FileText, type SiteBranding, type SiteLanguage, type SiteList, type SiteRecord, type TemplateProps, type ThemeComponents, type ThemeManifest, type ThemeQuery } from "../theme/define";
import { pageWords, wordsChain, type SiteWords } from "./words";

/** `alternates`: the record's address in each public language it can be read in, by language code. */
export type ResolvedAddress = { type: "record"; collection: string; path: string; record: SiteRecord; locale?: string; alternates?: Record<string, string> } | { type: "redirect"; to: string; status: number };

/** The site's public languages and how addresses carry them, as `GET /api/locales` answers. */
export interface SiteLocalization {
  defaultLocale: string;
  routing: SiteRouting;
  items: Array<{ code: string; label: string; direction: "ltr" | "rtl" }>;
  /** Owners' changes to the theme's words, by language, from Settings → Languages. */
  messages?: Record<string, Record<string, unknown>>;
}
/** The page being rendered, as plugins' components on every page see it. */
export interface EveryPageInfo {
  /** The address without its language prefix, such as /blog/hello. */
  path: string;
  /** The page's record's collection, or null on a page without one. */
  collection: string | null;
  recordId: number | null;
  /** The page's language on a site with more than one, or null. */
  locale: string | null;
  /** Whether an editor is previewing unpublished content. */
  preview: boolean;
}

export interface PreviewedRecord { collection: string; path: string | null; record: SiteRecord }

/**
 * The reads a themed page makes. `tansy/server` provides them in process and
 * `CmsClient.reader()` over HTTP, and both answer with the API's JSON, so the rest of
 * the rendering path is the same code in either mode.
 */
export interface SiteReader {
  /** `locale` reads the address in that language, `path` being the address without its prefix. Without it, a prefix in `path` decides. */
  resolve(path: string, options?: { locale?: string }): Promise<ResolvedAddress | null>;
  list(collection: string, options?: Record<string, unknown>): Promise<SiteList>;
  get(collection: string, id: number, options?: Record<string, unknown>): Promise<SiteRecord | null>;
  singleton(collection: string, options?: { locale?: string }): Promise<SiteRecord | null>;
  /** The public languages. A reader without it, or one answering null, serves one language. */
  localization?(): Promise<SiteLocalization | null>;
  branding(): Promise<SiteBranding & { accentColor?: string }>;
  preview(token: string): Promise<PreviewedRecord | null>;
  fileUrl(id: string, thumb?: "100x100" | "300x300" | "800x0"): string;
  /**
   * The same reads as the signed-in person making this request, as a member of the site:
   * API rules see who they are through @request.auth, and their role's permissions don't
   * apply. Null when nobody is signed in. Nothing it reads is cached or shared. A reader
   * without it, such as a headless one, shows members' pages as missing.
   */
  viewer?(): Promise<SiteReader | null>;
  /**
   * Props for plugins' components on every page, by name, for this page. A component
   * without props here isn't shown. A reader without it shows none of them.
   */
  everyPage?(page: EveryPageInfo): Promise<Record<string, unknown>>;
}

export interface SiteTheme<Options = unknown> {
  manifest: ThemeManifest<Options>;
  components: ThemeComponents<Options>;
}

export type LoadedPage<Options = unknown> =
  | { type: "redirect"; to: string; status: number }
  | { type: "missing" }
  | { type: "page"; template: string; source: TemplateSource; accent?: string; props: Omit<TemplateProps<Options>, "stream">; everyPage?: { page: EveryPageInfo; props: Record<string, unknown> } };

/** Whether a page's template comes from the theme or from a plugin's renderers. */
export type TemplateSource = "theme" | "plugin";

export interface LoadOptions {
  previewToken?: string | null;
  /** Plugins' renderers, from .tansy/render. Their templates render collections the theme has no template of its own for. */
  renderers?: Renderers;
  /** The `page` search parameter as the request carried it. Queries marked `paged` read that page of their list. */
  page?: string | string[] | number | null;
  /** The request's host, which picks the language when each language has its own domain. */
  host?: string | null;
  /**
   * The path prefix this site is served under, such as one tenant's "/acme", when it has one.
   * `requested` has already had it taken off, and every address the page builds carries it
   * again. The site layer passes it; a headless site routes for itself and passes none.
   */
  basePath?: string;
}

export const EMPTY_LIST: SiteList = { page: 1, perPage: 0, totalItems: 0, totalPages: 0, items: [] };

const own = <T>(map: Record<string, T> | undefined, key: string) => (map && Object.hasOwn(map, key) ? map[key] : undefined);

/** The theme's template for the collection, then a plugin's, then the theme's `home` or `default`. */
function chooseTemplate(components: ThemeComponents<never>, renderers: Renderers | undefined, path: string, collection: string | null): { name: string; source: TemplateSource } | null {
  const templates = components.templates;
  if (collection && Object.hasOwn(templates, collection)) return { name: collection, source: "theme" };
  if (collection && own(renderers?.templates, collection)) return { name: collection, source: "plugin" };
  if (path === "/" && Object.hasOwn(templates, "home")) return { name: "home", source: "theme" };
  return collection && Object.hasOwn(templates, "default") ? { name: "default", source: "theme" } : null;
}

async function loadRecord<Options>(manifest: ThemeManifest<Options>, renderers: Renderers | undefined, reader: SiteReader, address: { collection: string; record: SiteRecord }, locale: Record<string, string>) {
  const expand = own(manifest.expand, address.collection) ?? own(renderers?.expand, address.collection);
  if (!expand) return address.record;
  return (await reader.get(address.collection, address.record.id, { expand, ...locale })) ?? address.record;
}

interface PageLanguage {
  /** What the theme gets. Null for a site with one language. */
  language: SiteLanguage | null;
  /** The address without its language prefix. */
  path: string;
  /** Added to every read: `{ locale }`, or nothing on a site with one language. */
  options: Record<string, string>;
  overrides?: SiteLocalization["messages"];
  routing?: SiteRouting;
}

/** Which language an address is in, from its prefix or host. A site with one public language has no prefixes at all. */
async function pageLanguage(reader: SiteReader, path: string, host: string | null | undefined, basePath: string): Promise<PageLanguage> {
  const localization = await reader.localization?.().catch(() => null);
  if (!localization || localization.items.length < 2) return { language: null, path, options: {} };
  const codes = localization.items.map((item) => item.code);
  const split = splitLocalePath(path, localization.routing, codes, localization.defaultLocale, host);
  const current = localization.items.find((item) => item.code === split.locale)!;
  // The scope value's prefix sits outside the language's: /acme/ar/blog/hello.
  const address = (to: string, code: string) => withBasePath(basePath, hrefFor(localizePath(to, code, localization.routing, localization.defaultLocale)));
  return {
    path: split.path,
    options: { locale: split.locale },
    overrides: localization.messages,
    routing: localization.routing,
    language: {
      locale: split.locale,
      direction: current.direction,
      defaultLocale: localization.defaultLocale,
      // Every language's home page until a record says where its own translations live.
      alternates: Object.fromEntries(codes.map((code) => [code, address("/", code)])),
      locales: localization.items.map(({ code, label, direction }) => ({ code, label, direction })),
      href: (to, code = split.locale) => address(to, code),
    },
  };
}

/** Higher than any site would page to, and low enough that an offset stays cheap. */
const MAX_PAGE = 10_000;

/** A page number from `?page=`. Anything that isn't a plain whole number reads as the first page. */
export function pageNumber(value: LoadOptions["page"]): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = typeof raw === "number" ? String(raw) : raw ?? "";
  return /^[1-9]\d{0,4}$/.test(text) ? Math.min(Number(text), MAX_PAGE) : 1;
}

/** A filter may name the page's record as @record.<field>. A page with no record, or a value that can't be written in, gets an empty list. */
function runQuery(reader: SiteReader, { collection, filter, paged, ...rest }: ThemeQuery, record: SiteRecord | null, page: number): Promise<SiteList> {
  const bound = filter === undefined ? undefined : bindRecordFilter(filter, record);
  if (bound === null) return Promise.resolve(EMPTY_LIST);
  // `viewer` chose the reader. It isn't a list option.
  const options = Object.fromEntries(Object.entries(rest).filter(([name]) => name !== "viewer"));
  return reader.list(collection, { ...options, ...(bound === undefined ? {} : { filter: bound }), ...(paged ? { page } : {}) });
}

/**
 * The lists a template declared. A theme's template for a plugin's collection still gets the
 * plugin's lists, so the parts the plugin exports work in it, and the theme's own lists win on a name.
 */
function queriesFor<Options>(manifest: ThemeManifest<Options>, renderers: Renderers | undefined, template: string, source: TemplateSource) {
  return { ...own(renderers?.queries, template), ...(source === "theme" ? own(manifest.queries, template) : {}) };
}

/**
 * Everything a page needs, as data. A redirect or a missing page comes back as a
 * value, so each kind of host can answer it in its own way.
 *
 * A preview token applies only to the address of the record it was made for. Every other
 * page reads as a visitor, except where it needs the signed-in member: a record only they
 * may view, and queries marked `viewer`. Those go through `reader.viewer()`.
 */
export async function loadSitePage<Options>(theme: SiteTheme<Options>, reader: SiteReader, requested: string, { previewToken, renderers, page: requestedPage, host, basePath = "" }: LoadOptions = {}): Promise<LoadedPage<Options>> {
  const { manifest, components } = theme;
  const fullPath = normalizePath(requested);
  if (fullPath === null) return { type: "missing" };
  const { language, path, options: inLanguage, overrides, routing } = await pageLanguage(reader, fullPath, host, basePath);

  // Looked up at most once, and only when a page needs it, so visitors' pages stay shared reads.
  let member: Promise<SiteReader | null> | undefined;
  const viewer = () => (member ??= reader.viewer?.() ?? Promise.resolve(null));

  const previewed = previewToken ? await reader.preview(previewToken) : null;
  const preview = previewed?.path === path ? previewed : null;
  let address = preview ? null : await reader.resolve(path, inLanguage);
  // A record visitors can't see may be one this member can, such as a lesson in a course they joined.
  // Everything about that record is then read as them.
  let recordReader = reader;
  if (!preview && !address) {
    const asMember = await viewer();
    address = asMember ? await asMember.resolve(path, inLanguage) : null;
    if (asMember && address) recordReader = asMember;
  }
  if (address?.type === "redirect") return address;

  const target = preview ?? (address?.type === "record" ? address : null);
  const collection = target?.collection ?? null;
  const chosen = chooseTemplate(components as ThemeComponents<never>, renderers, path, collection);
  if (!chosen) return { type: "missing" };
  const { name: template, source } = chosen;

  const pageNo = pageNumber(requestedPage);
  const info: EveryPageInfo = { path, collection, recordId: target?.record.id ?? null, locale: language?.locale ?? null, preview: preview !== null };
  const queries = Object.entries(queriesFor(manifest, renderers, template, source));
  const readerFor = async (query: ThemeQuery) => (query.viewer ? (await viewer()) ?? reader : reader);
  const [record, branding, lists, globals, everyPage] = await Promise.all([
    target ? (preview ? target.record : loadRecord(manifest, renderers, recordReader, target, inLanguage)) : null,
    reader.branding(),
    Promise.all(queries.map(async ([name, query]) => [name, await runQuery(await readerFor(query), { ...inLanguage, ...query }, target?.record ?? null, pageNo)] as const)),
    Promise.all((manifest.singletons ?? []).map(async (slug) => [slug, await reader.singleton(slug, inLanguage)] as const)),
    reader.everyPage ? reader.everyPage(info) : null,
  ]);
  // Page 1 of an empty list is a real page. Past the end of a paged list isn't.
  if (pageNo > 1 && queries.some(([, query], i) => query.paged && lists[i][1].totalPages < pageNo)) return { type: "missing" };

  // Each record carries the text and focal point of the files it uses, so this needs no read of its own.
  const files = fileMetaOf([record, ...lists.flatMap(([, list]) => list.items), ...globals.map(([, item]) => item)]);

  return {
    type: "page",
    template,
    source,
    accent: branding.accentColor,
    ...(everyPage && Object.keys(everyPage).length ? { everyPage: { page: info, props: everyPage } } : {}),
    props: {
      path,
      collection,
      record,
      data: Object.fromEntries(lists),
      globals: Object.fromEntries(globals),
      options: manifest.options?.value as Options,
      branding: { name: branding.name, logoUrl: branding.logoUrl },
      preview: preview !== null,
      fileUrl: (id, thumb) => reader.fileUrl(id, thumb),
      fileText: (id) => files.text.get(id) ?? NO_FILE_TEXT,
      fileFocus: (id) => files.focus.get(id) ?? NO_FILE_FOCUS,
      language: language && address?.type === "record" && address.alternates ? { ...language, alternates: address.alternates } : language,
      ...wordsFor(components as ThemeComponents, renderers, language, overrides, routing, basePath),
    },
  };
}

/**
 * The text and focal point of every file the records on this page use, by file id, as each
 * record's own `files` map carries them. A headless reader answers with the same JSON, so both
 * modes agree. A file with no focal point is left out, and `fileFocus` then answers the middle.
 */
function fileMetaOf(records: Array<SiteRecord | null>) {
  type Carried = Partial<FileText> & { focus?: { x?: number; y?: number } };
  const text = new Map<string, FileText>();
  const focus = new Map<string, FileFocus>();
  for (const record of records) {
    const files = record?.files;
    if (!files || typeof files !== "object") continue;
    for (const [id, carried] of Object.entries(files as Record<string, Carried>)) {
      if (!text.has(id)) text.set(id, { alt: carried?.alt ?? "", caption: carried?.caption ?? "", credit: carried?.credit ?? "" });
      const point = carried?.focus;
      if (!focus.has(id) && typeof point?.x === "number" && typeof point?.y === "number") {
        focus.set(id, { x: point.x, y: point.y, objectPosition: `${point.x}% ${point.y}%` });
      }
    }
  }
  return { text, focus };
}

/**
 * What `sitePath()` needs in a client component: the page's language and how addresses carry
 * it, and the path prefix the site is served under. A site with one language and no prefix
 * needs none of it, so none is sent.
 */
function siteOf(locale: string, language: SiteLanguage | null, routing: SiteRouting | undefined, basePath: string): SiteWords["site"] {
  const prefix = basePath ? { basePath } : {};
  if (language && routing) return { locale: language.locale, defaultLocale: language.defaultLocale, routing, ...prefix };
  if (!basePath) return undefined;
  return { locale, defaultLocale: locale, routing: { mode: "none", prefixDefault: false, domains: {} }, ...prefix };
}

/** The page's words in its language: plugins' site words, the theme's over them, the owner's changes over both, falling back along the chain. */
function wordsFor(components: ThemeComponents, renderers: Renderers | undefined, language: SiteLanguage | null, overrides: SiteLocalization["messages"], routing: SiteRouting | undefined, basePath: string) {
  const locale = language?.locale ?? components.defaultLocale ?? "en";
  const words = pageWords(locale, wordsChain(locale, language?.defaultLocale, components.defaultLocale), {
    plugins: renderers?.messages,
    theme: components.messages,
    owner: overrides as Record<string, Messages> | undefined,
  }, siteOf(locale, language, routing, basePath));
  const { t, formatDate, formatNumber } = formatters(locale, words.messages);
  return { words, t, formatDate, formatNumber };
}

/** The title and description a page's <head> should carry. */
export function pageMetadata<Options>(theme: SiteTheme<Options>, loaded: Extract<LoadedPage<Options>, { type: "page" }>, renderers?: Renderers) {
  const props: TemplateProps<Options> = { ...loaded.props, stream: streamProps(theme.components as ThemeComponents, renderers, loaded.props.words) };
  const custom = theme.components.metadata?.(props);
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const { record, branding, language } = loaded.props;
  return {
    title: custom?.title ?? text(record?.seo_title) ?? text(record?.title) ?? branding.name,
    description: custom?.description ?? text(record?.seo_description) ?? text(record?.summary),
    // hreflang for search engines, with the default language as x-default.
    ...(language ? { alternates: { languages: { ...language.alternates, ...(language.alternates[language.defaultLocale] ? { "x-default": language.alternates[language.defaultLocale] } : {}) } } } : {}),
  };
}

export function streamProps(components: ThemeComponents, renderers: Renderers | undefined, words?: SiteWords): { theme: Renderers; renderers?: Renderers; words?: SiteWords } {
  return { theme: { blocks: components.blocks, fields: components.fields }, renderers, ...(words ? { words } : {}) };
}
