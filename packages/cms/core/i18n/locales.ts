import "server-only";
import { z } from "zod";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { HttpError } from "../http/errors";
import { invalidateSiteCache } from "../site/cache";
import { canonicalLocale, chainProblem, fallbackChain, nativeName, textDirection } from "./codes";

export interface LocaleInfo {
  code: string;
  label: string;
  fallback: string | null;
  direction: "ltr" | "rtl";
  public: boolean;
  position: number;
}

const routingSchema = z.object({
  /** "prefix": /fr/blog/x. "domains": a host per language. "none": one language per site address. */
  mode: z.enum(["prefix", "domains", "none"]).default("prefix"),
  /** Whether the default language has a prefix too, as /en/blog/x. */
  prefixDefault: z.boolean().default(false),
  /** Host per language code, for "domains". */
  domains: z.record(z.string().max(35), z.string().max(253).regex(/^[a-z0-9.-]+(:\d{1,5})?$/)).default({}),
  /** At "/" only, send a first-time visitor to the language their browser asks for. */
  detectRoot: z.boolean().default(false),
});

/** A message's text: ICU, never HTML, as React escapes whatever it renders. */
const siteMessage: z.ZodType<Record<string, unknown>> = z.lazy(() => z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.union([z.string().max(2000), siteMessage])));

export const localizationSettingsSchema = z.object({
  defaultLocale: z.string().max(35).default(""),
  routing: routingSchema.default({ mode: "prefix", prefixDefault: false, domains: {}, detectRoot: false }),
  /** Owners' changes to the theme's words, by language code. */
  siteText: z.record(z.string().max(35), siteMessage).default({}),
});

export type LocalizationSettings = z.output<typeof localizationSettingsSchema>;
export type RoutingSettings = LocalizationSettings["routing"];

export const LOCALIZATION_KEY = "localization";

interface Registry {
  locales: LocaleInfo[];
  settings: LocalizationSettings;
}

declare const globalThis: { cmsLocales?: Promise<Registry> | null } & typeof global;

/** The language a site has before anyone adds another. */
const initialLocale = () => canonicalLocale(process.env.TANSY_DEFAULT_LOCALE) ?? "en";

async function load(): Promise<Registry> {
  let rows = await prisma.locale.findMany({ orderBy: [{ position: "asc" }, { code: "asc" }] });
  if (!rows.length) {
    const code = initialLocale();
    await prisma.locale.upsert({ where: { code }, create: { code, label: nativeName(code), direction: textDirection(code), public: true }, update: {} });
    rows = await prisma.locale.findMany({ orderBy: [{ position: "asc" }, { code: "asc" }] });
  }
  const stored = await prisma.appSetting.findUnique({ where: { key: LOCALIZATION_KEY } });
  const settings = localizationSettingsSchema.parse(stored?.value ?? {});
  if (!rows.some((row) => row.code === settings.defaultLocale)) settings.defaultLocale = rows[0].code;
  return {
    locales: rows.map((row) => ({ code: row.code, label: row.label, fallback: row.fallback, direction: row.direction === "rtl" ? "rtl" : "ltr", public: row.public, position: row.position })),
    settings,
  };
}

/** One server process (main plan, decision 3), so an in-memory copy cleared on every change stays right. */
function registry(): Promise<Registry> {
  return (globalThis.cmsLocales ??= load().catch((error) => {
    globalThis.cmsLocales = null;
    throw error;
  }));
}

export function invalidateLocales() {
  globalThis.cmsLocales = null;
  // Cached site reads hold addresses and words chosen by the old languages.
  invalidateSiteCache();
}

export const listLocales = async () => (await registry()).locales;
export const localizationSettings = async () => (await registry()).settings;
export const defaultLocale = async () => (await registry()).settings.defaultLocale;
/**
 * Public languages, as the current scope value's site offers them: one value can leave some of
 * the instance's out (core/site/identity.ts), never the default language.
 */
async function scopedLocales(): Promise<{ locales: LocaleInfo[]; settings: Registry["settings"] }> {
  const { locales, settings } = await registry();
  const { hiddenLocalesHere } = await import("../site/identity");
  const hidden = await hiddenLocalesHere();
  if (!hidden.size) return { locales, settings };
  return { locales: locales.map((locale) => (locale.public && hidden.has(locale.code) && locale.code !== settings.defaultLocale ? { ...locale, public: false } : locale)), settings };
}

export const publicLocales = async () => (await scopedLocales()).locales.filter((locale) => locale.public);

/** The languages to read for `code`, nearest first, ending at the default. */
export async function chainFor(code: string) {
  const { locales, settings } = await registry();
  return fallbackChain(code, locales, settings.defaultLocale);
}

export interface LocaleCatalog {
  locales: LocaleInfo[];
  defaultLocale: string;
  chain(code: string): string[];
  has(code: string): boolean;
  isPublic(code: string): boolean;
}

/** Everything a request needs to resolve languages, read once. */
export async function localeCatalog(): Promise<LocaleCatalog> {
  const { locales, settings } = await scopedLocales();
  const codes = new Map(locales.map((locale) => [locale.code, locale]));
  return {
    locales,
    defaultLocale: settings.defaultLocale,
    chain: (code) => fallbackChain(code, locales, settings.defaultLocale),
    has: (code) => codes.has(code),
    isPublic: (code) => codes.get(code)?.public === true,
  };
}

const invalid = (path: string, message: string) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path, message }]);

export const localeInput = z.object({
  code: z.string().max(35),
  label: z.string().trim().min(1).max(100).optional(),
  fallback: z.string().max(35).nullable().optional(),
  direction: z.enum(["ltr", "rtl"]).optional(),
  public: z.boolean().optional(),
});

export const localeUpdate = localeInput.omit({ code: true }).extend({ position: z.number().int().min(0).max(10_000).optional() });

async function assertChains(next: LocaleInfo[], defaultCode: string) {
  const problem = chainProblem(next, defaultCode);
  if (problem) throw invalid("fallback", problem);
}

export async function createLocale(input: z.output<typeof localeInput>) {
  const code = canonicalLocale(input.code);
  if (!code) throw invalid("code", "Use a language code such as en, fr-CA or zh-Hant.");
  const { locales, settings } = await registry();
  if (locales.some((locale) => locale.code === code)) throw new HttpError(409, "CONFLICT", "That language already exists.", [{ path: "code", message: "That language already exists." }]);
  const created: LocaleInfo = {
    code,
    label: input.label ?? nativeName(code),
    fallback: input.fallback ? canonicalLocale(input.fallback) : null,
    direction: input.direction ?? textDirection(code),
    public: input.public ?? false,
    position: Math.max(0, ...locales.map((locale) => locale.position + 1)),
  };
  await assertChains([...locales, created], settings.defaultLocale);
  await prisma.locale.create({ data: created });
  invalidateLocales();
  return created;
}

export async function updateLocale(code: string, input: z.output<typeof localeUpdate>) {
  const { locales, settings } = await registry();
  const current = locales.find((locale) => locale.code === code);
  if (!current) throw new HttpError(404, "NOT_FOUND", "Language not found.");
  const next: LocaleInfo = {
    ...current,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.fallback !== undefined ? { fallback: input.fallback === null ? null : canonicalLocale(input.fallback) ?? input.fallback } : {}),
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(input.public !== undefined ? { public: input.public } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
  };
  if (code === settings.defaultLocale && !next.public) throw invalid("public", "The default language is always public.");
  await assertChains(locales.map((locale) => (locale.code === code ? next : locale)), settings.defaultLocale);
  await prisma.locale.update({ where: { code }, data: { label: next.label, fallback: next.fallback, direction: next.direction, public: next.public, position: next.position } });
  invalidateLocales();
  return next;
}

/** Changing the default is a setting. Records keep every translation they have. */
export async function setDefaultLocale(code: string, updatedById: string | null) {
  const { locales, settings } = await registry();
  const target = locales.find((locale) => locale.code === code);
  if (!target) throw invalid("defaultLocale", "That language doesn't exist.");
  await assertChains(locales, code);
  if (!target.public) await prisma.locale.update({ where: { code }, data: { public: true } });
  await saveSettings({ ...settings, defaultLocale: code }, updatedById);
  invalidateLocales();
  const { refreshDefaultMirrors } = await import("./storage");
  await refreshDefaultMirrors(code);
}

export async function setRouting(routing: z.input<typeof routingSchema>, updatedById: string | null) {
  const { locales, settings } = await registry();
  const parsed = routingSchema.parse(routing);
  for (const code of Object.keys(parsed.domains)) {
    if (!locales.some((locale) => locale.code === code)) throw invalid(`routing.domains.${code}`, "That language doesn't exist.");
  }
  const hosts = Object.values(parsed.domains);
  if (new Set(hosts).size !== hosts.length) throw invalid("routing.domains", "Each language needs its own host.");
  await saveSettings({ ...settings, routing: parsed }, updatedById);
  invalidateLocales();
}

const depth = (value: unknown): number => (value && typeof value === "object" ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0);

/** Replaces one language's changes to the theme's words. Each message must be valid ICU. */
export async function setSiteText(code: string, messages: Record<string, unknown>, updatedById: string | null) {
  const { locales, settings } = await registry();
  if (!locales.some((locale) => locale.code === code)) throw invalid("locale", "That language doesn't exist.");
  if (JSON.stringify(messages).length > 256 * 1024) throw invalid("messages", "Keep site text under 256 KB per language.");
  if (depth(messages) > 6) throw invalid("messages", "Group messages at most 6 levels deep.");
  const result = siteMessage.safeParse(messages);
  if (!result.success) throw invalid("messages", "Each key is letters, digits, - or _, and each message is text of up to 2,000 characters.");
  const parsed = result.data;
  const { messageProblems } = await import("./messages");
  const problems = messageProblems(parsed as never);
  if (problems.length) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", problems.slice(0, 20).map((message) => ({ path: "messages", message })));
  const siteText = { ...settings.siteText };
  if (Object.keys(parsed).length) siteText[code] = parsed;
  else delete siteText[code];
  await saveSettings({ ...settings, siteText }, updatedById);
  invalidateLocales();
}

async function saveSettings(settings: LocalizationSettings, updatedById: string | null) {
  // Plain JSON by construction: the schema above admits strings, booleans and nested records only.
  const value = JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: LOCALIZATION_KEY },
    create: { key: LOCALIZATION_KEY, value, updatedById },
    update: { value, updatedById, version: { increment: 1 } },
  });
}

/**
 * Removes a language from the list. Its translations stay where they are, unread,
 * unless `purge` is set, which deletes them for good.
 */
export async function deleteLocale(code: string, purge: boolean) {
  const { locales, settings } = await registry();
  if (!locales.some((locale) => locale.code === code)) throw new HttpError(404, "NOT_FOUND", "Language not found.");
  if (code === settings.defaultLocale) throw invalid("code", "Choose another default language first.");
  const dependents = locales.filter((locale) => locale.fallback === code);
  if (dependents.length) throw invalid("code", `${dependents.map((locale) => locale.code).join(", ")} fall back to this language. Change that first.`);
  const removed = purge ? await (await import("./storage")).purgeLocaleContent(code) : 0;
  await prisma.locale.delete({ where: { code } });
  invalidateLocales();
  return { purged: removed };
}
