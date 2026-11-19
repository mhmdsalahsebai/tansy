import "server-only";
import { cookies, headers } from "next/headers";
import prisma from "../../lib/prisma";
import { getCmsConfig } from "../config";
import { ADMIN_CATALOGS, ADMIN_DEFAULT, ADMIN_LOCALES } from "./catalogs";
import { canonicalLocale, negotiateLocale, textDirection } from "./codes";
import { formatters, mergeMessages, messagesFor, type Messages } from "./messages";
import { adminPath } from "../../lib/paths";
import { localeCatalog, localizationSettings } from "./locales";
import { splitLocalePath } from "./routing";

/** Remembers the interface language in the browser, so pages outside the dashboard, such as sign-in, use it too. */
export const ADMIN_LOCALE_COOKIE = "cms-admin-locale";

/** A language the dashboard has a catalog for, or null. "ar-EG" becomes "ar". */
export function supportedAdminLocale(raw: string | null | undefined): string | null {
  const code = canonicalLocale(raw);
  if (!code) return null;
  if (ADMIN_LOCALES.includes(code)) return code;
  const base = code.split("-")[0];
  return ADMIN_LOCALES.includes(base) ? base : null;
}

/** The instance's default interface language, from TANSY_ADMIN_LOCALE, or English. */
const instanceDefault = () => supportedAdminLocale(process.env.TANSY_ADMIN_LOCALE) ?? ADMIN_DEFAULT;

/**
 * The interface language for this request: the person's choice when they're known, then
 * the cookie that choice sets, then the browser's languages, then the instance's default.
 */
export async function adminLocale(userId?: string | null): Promise<string> {
  if (userId) {
    const profile = await prisma.userProfile.findUnique({ where: { userId }, select: { locale: true } });
    const chosen = supportedAdminLocale(profile?.locale);
    if (chosen) return chosen;
  }
  const remembered = supportedAdminLocale((await cookies()).get(ADMIN_LOCALE_COOKIE)?.value);
  if (remembered) return remembered;
  const header = (await headers()).get("accept-language");
  return negotiateLocale(header, ADMIN_LOCALES) ?? instanceDefault();
}

export const adminDirection = (locale: string) => textDirection(locale);

/**
 * `<html lang dir>` for this request. The dashboard, sign-in and account pages use the
 * person's interface language. A site page uses the language its address is in, never
 * the visitor's browser, so an English site doesn't turn right to left for an Arabic one.
 */
export async function documentLanguage(): Promise<{ locale: string; direction: "ltr" | "rtl" }> {
  const requestHeaders = await headers();
  const path = requestHeaders.get("x-pathname") ?? "/";
  const admin = adminPath();
  if (path === admin || path.startsWith(`${admin}/`)) {
    const locale = await adminLocale();
    return { locale, direction: adminDirection(locale) };
  }
  const [catalog, settings] = await Promise.all([localeCatalog(), localizationSettings()]);
  const visible = catalog.locales.filter((locale) => locale.public);
  const locale = visible.length > 1 ? splitLocalePath(path, settings.routing, visible.map((entry) => entry.code), catalog.defaultLocale, requestHeaders.get("host")).locale : catalog.defaultLocale;
  return { locale, direction: catalog.locales.find((entry) => entry.code === locale)?.direction ?? textDirection(locale) };
}

/** Saves a person's interface language, or null to follow their browser. */
export async function saveAdminLocale(userId: string, locale: string | null) {
  await prisma.userProfile.upsert({ where: { userId }, create: { userId, values: {}, locale }, update: { locale } });
}

/** The language a person picked under their account, or null when they follow their browser. */
export async function chosenAdminLocale(userId: string) {
  const profile = await prisma.userProfile.findUnique({ where: { userId }, select: { locale: true } });
  return supportedAdminLocale(profile?.locale);
}

/** Core's words in this language over English, with each plugin's under `ext.<plugin>`. */
export function adminMessages(locale: string): Messages {
  const plugins: Record<string, Messages> = {};
  for (const plugin of getCmsConfig().plugins ?? []) {
    if (plugin.messages) plugins[plugin.name] = messagesFor(plugin.messages, [locale, ADMIN_DEFAULT]);
  }
  const core = mergeMessages(ADMIN_CATALOGS[ADMIN_DEFAULT] as unknown as Messages, ADMIN_CATALOGS[locale] as unknown as Messages);
  return Object.keys(plugins).length ? { ...core, ext: plugins } : core;
}

/**
 * The language to write to someone in: the one they chose, otherwise the instance's
 * default. Never their browser's, which a mail sender doesn't know.
 */
export async function recipientLocale(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } }).catch(() => null);
  const chosen = user ? await chosenAdminLocale(user.id) : null;
  return chosen ?? instanceDefault();
}

/** Core's words for an email to this address, with the language they're in. */
export async function mailWords(email: string) {
  const locale = await recipientLocale(email);
  return { locale, direction: adminDirection(locale), t: formatters(locale, adminMessages(locale)).t };
}

/** Core's and plugins' words in one interface language, with its formatters. */
export const wordsIn = (locale: string) => ({ locale, direction: adminDirection(locale), ...formatters(locale, adminMessages(locale)) });

export { ADMIN_DEFAULT };

/** `t()` in a server component: `(await getT()).t("nav.Collections")`. */
export async function getT(userId?: string | null) {
  return wordsIn(await adminLocale(userId));
}
