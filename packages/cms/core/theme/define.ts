import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import type { BlockProps, FieldRenderProps, Renderers } from "../../components/stream/StreamField";
import type { Formatters, Messages } from "../i18n/messages";
import type { SiteWords } from "../site/words";
import { TANSY_VERSION } from "../version";
import { isVersion, satisfies } from "../extend/semver";
import { adminTokensProblem, tokensProblem, type AdminTokens, type ThemeTokens } from "./tokens";

/** The theme contract this CMS provides. It changes only when an existing theme would stop working. */
export const THEME_API_VERSION = 1;

const THEME_NAME = /^[a-z][a-z0-9-]{0,39}$/;
// Written into a generated import statement, so nothing but a module path gets through.
const MODULE = /^(?:\.{1,2}\/|(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*\/?)[A-Za-z0-9._/-]*$/;
const SITE_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|svg\+xml)[;,][A-Za-z0-9+/=;,%._-]*$/;

export interface ThemeQuery {
  collection: string;
  sort?: string;
  /**
   * May name fields of the record the page shows as `@record.<field>`, such as `categories ?= @record.id`.
   * A list field matches when any of its values does: `tags ?= @record.tags && id != @record.id`.
   * On a page with no record, such a query returns nothing.
   */
  filter?: string;
  perPage?: number;
  /** Follows the page's `?page=` number. A number past the last page shows the not-found page. */
  paged?: boolean;
  expand?: string;
  fields?: string;
  /** "1" adds `recordPath` to each item, its address from the collection's URL pattern. */
  urls?: "1";
  /**
   * Runs as the signed-in viewer, so API rules that read @request.auth decide what it
   * returns, such as `student = @request.auth.id`. Signed out, it runs as a visitor.
   * Staff get only what the rules give them, as any member would. Never cached.
   */
  viewer?: boolean;
}

/**
 * What tansy.config.ts holds. No React, so API routes never import any: `render` names the
 * components as a module path, and `tansy sync` turns that into an import.
 */
export interface ThemeManifest<Options = unknown> {
  /** Lowercase letters, digits and hyphens. */
  name: string;
  version: string;
  /** THEME_API_VERSION when the theme was built. */
  apiVersion: number;
  /** A module whose default export comes from defineThemeComponents. No server imports, so a headless site can use it. */
  render: string;
  requires?: { cms?: string; plugins?: string[] };
  tokens?: ThemeTokens;
  /** Checked at startup, and handed to templates. Reaches headless sites, so never put secrets in it. */
  options?: { schema: z.ZodType; value: Options };
  /** A portable schema document. Collections and blocks that don't exist yet are created once per theme version. Nothing existing is changed. */
  schema?: unknown;
  /** Singletons loaded for every page, available to layouts and templates as `globals`. */
  singletons?: string[];
  /** Per template name, the lists it needs. Each runs as a signed-out visitor, unless it sets `viewer`. */
  queries?: Record<string, Record<string, ThemeQuery>>;
  /** Per collection slug, what to expand on its record pages. */
  expand?: Record<string, string>;
}

export type SiteRecord = Record<string, unknown> & { id: number };

/** What a file is described as, in one language. Records carry this for the files they use, under `files`. */
export interface FileText {
  alt: string;
  caption: string;
  credit: string;
}

export const NO_FILE_TEXT: FileText = { alt: "", caption: "", credit: "" };

/**
 * Where the subject of a picture is, so a theme crops in the browser the way a thumbnail does
 * on the server. Records carry it for the files they use, beside their text.
 */
export interface FileFocus {
  /** Whole percentages from the left and from the top. The middle for a file with no focal point. */
  x: number;
  y: number;
  /** Ready for CSS `object-position`, beside `object-fit: cover`. */
  objectPosition: string;
}

export const NO_FILE_FOCUS: FileFocus = { x: 50, y: 50, objectPosition: "50% 50%" };

export interface SiteList {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: SiteRecord[];
}

/** The page's language, on a site with more than one. */
export interface SiteLanguage {
  locale: string;
  direction: "ltr" | "rtl";
  defaultLocale: string;
  /** This page's address in each public language, by code: the record's own translations, or each language's home page. For a language switcher and `hreflang`. */
  alternates: Record<string, string>;
  locales: Array<{ code: string; label: string; direction: "ltr" | "rtl" }>;
  /** A site address in this language, or another: `href("/blog")` is "/fr/blog" on a French page. */
  href(path: string, locale?: string): string;
}

export interface SiteBranding {
  name: string;
  logoUrl: string;
}

/** Spread onto <StreamField> so blocks use the theme's components and plugins' defaults. */
export interface StreamProps {
  theme: Renderers;
  renderers?: Renderers;
  fallback?: ComponentType<BlockProps>;
  /** The page's words, passed on to every block. */
  words?: SiteWords;
}

export interface TemplateProps<Options = unknown> {
  path: string;
  /** Null on a home page that isn't a record. */
  collection: string | null;
  record: SiteRecord | null;
  /** The lists this template declared under `queries`. */
  data: Record<string, SiteList>;
  globals: Record<string, SiteRecord | null>;
  options: Options;
  branding: SiteBranding;
  /** True when this shows unpublished changes. */
  preview: boolean;
  fileUrl(id: string, thumb?: "100x100" | "300x300" | "800x0"): string;
  /**
   * How a file is described, in this page's language: `alt` for an image's alternative text,
   * with `caption` and `credit` where a theme shows them. Empty strings when the file has no
   * text, or isn't one of the files the records on this page use, which is what a template
   * renders. Set in the library, or beside the field (core/files).
   */
  fileText(id: string): FileText;
  /**
   * Where to crop a picture, for the same files `fileText` covers: spread its `objectPosition`
   * onto an `<img>` that crops, and a face stays in frame at any shape. The middle for a file
   * with no focal point, so it is always safe to use. Set in the library, or beside the field.
   */
  fileFocus(id: string): FileFocus;
  stream: StreamProps;
  /** Null on a site with one language. */
  language: SiteLanguage | null;
  /**
   * The page's words in its language: the theme's, such as `t("readMore")`, and plugins' site
   * words under each plugin's name, such as `t("shop.addToCart")`.
   */
  t: Formatters["t"];
  formatDate: Formatters["formatDate"];
  formatNumber: Formatters["formatNumber"];
  /**
   * The same words as plain data, for a client component: pass `pickWords(words, "shop")` and
   * call `siteWords()` on it there. `loadSitePage` always sets it. Optional only so code that
   * builds these props by hand keeps compiling.
   */
  words?: SiteWords;
}

export type LayoutProps<Options = unknown> = TemplateProps<Options> & { children: ReactNode };

export interface ThemeMetadata { title?: string; description?: string }

/** The React half of a theme, the default export of the module named by `render`. It may run on any site, so keep server code out of it. */
export interface ThemeComponents<Options = unknown> {
  blocks?: Record<string, ComponentType<BlockProps>>;
  fields?: Record<string, ComponentType<FieldRenderProps>>;
  /** By collection slug, with `default` for the rest and `home` for a site's root when no record lives there. */
  templates: Record<string, ComponentType<TemplateProps<Options>>>;
  layouts?: { default?: ComponentType<LayoutProps<Options>> } & Record<string, ComponentType<LayoutProps<Options>>>;
  /** Class names from next/font, which serves font files from the site itself as the Content Security Policy requires. */
  fontClassName?: string;
  /** Overrides the default title and description, taken from `seo_title`, `title`, `seo_description` and `summary`. */
  metadata?: (props: TemplateProps<Options>) => ThemeMetadata;
  /**
   * The theme's own words, by language code, in ICU MessageFormat:
   * `{ en: { readMore: "Read more" }, ar: { readMore: "اقرأ المزيد" } }`. Templates get them through `t()`.
   * Owners can change any of them per language under Settings → Languages.
   */
  messages?: Record<string, Messages>;
  /** The language the theme's words are written in first, which others fall back to. "en" unless set. */
  defaultLocale?: string;
}

export const defineThemeComponents = <Options = unknown>(components: ThemeComponents<Options>) => components;

function checkManifest(theme: ThemeManifest, cmsVersion: string, plugins?: string[]) {
  const label = `Theme "${theme.name}"`;
  const fail = (problem: string): never => { throw new Error(`${label}: ${problem}`); };

  if (!THEME_NAME.test(theme.name)) fail("the name must be lowercase letters, digits and hyphens, starting with a letter.");
  if (typeof theme.version !== "string" || !isVersion(theme.version)) fail(`version must look like 1.2.0. Got "${theme.version}".`);
  if (theme.apiVersion !== THEME_API_VERSION) fail(`it was built for theme API ${theme.apiVersion}, and this CMS provides API ${THEME_API_VERSION}. Install a version of the theme made for it.`);
  if (typeof theme.render !== "string" || !MODULE.test(theme.render)) fail(`render must be a module path such as "@acme/theme/render". Got "${theme.render}".`);

  const wanted = theme.requires?.cms;
  if (wanted !== undefined) {
    let matches = false;
    try {
      matches = satisfies(cmsVersion, wanted);
    } catch (error) {
      fail(`requires.cms is not usable. ${(error as Error).message}`);
    }
    if (!matches) fail(`it requires tansy ${wanted}, and this is ${cmsVersion}. Upgrade one of them, or change the theme in tansy.config.ts.`);
  }
  if (plugins) {
    for (const needed of theme.requires?.plugins ?? []) {
      if (!plugins.includes(needed)) fail(`it requires the "${needed}" plugin. Add it to plugins in tansy.config.ts.`);
    }
  }

  const tokens = tokensProblem(theme.tokens ?? {});
  if (tokens) fail(tokens);

  if (theme.options) {
    const parsed = theme.options.schema.safeParse(theme.options.value);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      fail(`invalid option${issue.path.length ? ` "${issue.path.join(".")}"` : ""}: ${issue.message}`);
    }
  }
}

/** Runs where the theme is created, which for tansy.config.ts means `tansy sync`, so a bad token fails the build. */
export function defineTheme<Options = unknown>(theme: ThemeManifest<Options>): ThemeManifest<Options> {
  checkManifest(theme as ThemeManifest, TANSY_VERSION);
  return theme;
}

/** At startup, when the plugins actually running are known. */
export function assertThemeManifest(theme: ThemeManifest, plugins: string[], cmsVersion: string = TANSY_VERSION) {
  checkManifest(theme, cmsVersion, plugins);
}

/** The dashboard sends tokens to this address, so it has to be a plain http or https URL. */
export function assertPreviewUrl(url: string) {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch { /* reported below */ }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash) throw new Error(`previewUrl must be an http or https URL with no query string, such as https://example.com/api/preview. Got "${url}".`);
}

/** Tokens and a logo only. An admin theme can't replace components. */
export interface AdminTheme {
  name: string;
  /** Names are the admin's --cms- tokens without that prefix, such as "color-surface". */
  tokens: { light?: AdminTokens; dark?: AdminTokens };
  /** A path in the app's public folder or a data: image. Used until a logo is set under Settings. */
  logo?: string;
}

export function defineAdminTheme(theme: AdminTheme): AdminTheme {
  const label = `Admin theme "${theme.name}"`;
  if (!THEME_NAME.test(theme.name)) throw new Error(`${label}: the name must be lowercase letters, digits and hyphens, starting with a letter.`);
  const problem = adminTokensProblem(theme.tokens.light ?? {}) ?? adminTokensProblem(theme.tokens.dark ?? {});
  if (problem) throw new Error(`${label}: ${problem}`);
  // Only these two forms load under the admin's img-src, and neither can reach another site.
  if (theme.logo !== undefined && !(SITE_PATH.test(theme.logo) && !theme.logo.startsWith("//")) && !DATA_IMAGE.test(theme.logo)) throw new Error(`${label}: logo must be a path such as "/logo.svg" or a data: image.`);
  return theme;
}
