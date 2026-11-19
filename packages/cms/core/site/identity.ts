import "server-only";
import { z } from "zod";
import { accentColour, logoPath } from "../auth/settings-schema";
import { readScopedSetting, writeScopedSetting } from "../settings/scoped";
import { currentScopeValue } from "../scope/context";
import { invalidateSiteCache } from "./cache";

/**
 * A scope value's own site name, logo, accent colour and theme, such as one tenant's (C29). Each
 * one left empty falls back to the instance's, under Settings → General, and an empty `theme` to
 * the build's default theme. `hiddenLocales` are public languages this value's site doesn't offer:
 * it can narrow the instance's, never add one.
 *
 * `theme` is only name-shaped here, never checked against the themes installed: a theme can leave
 * a build after a site chose it, and a stored name that no longer matches must still parse, or
 * this value would lose its name and colour with it. The site falls back to the default theme
 * (core/theme/installed.ts), and the route that saves this only offers themes the build has.
 */
export const siteIdentitySchema = z.strictObject({
  name: z.string().trim().max(80).default(""),
  logoUrl: logoPath().default(""),
  accentColor: accentColour().default(""),
  theme: z.string().trim().max(40).regex(/^$|^[a-z][a-z0-9-]{0,39}$/, "A theme name is lowercase letters, digits and hyphens.").default(""),
  hiddenLocales: z.array(z.string().max(35)).max(200).default([]),
});

export type SiteIdentity = z.infer<typeof siteIdentitySchema>;

export const SITE_IDENTITY_KEY = "site";

const EMPTY: SiteIdentity = { name: "", logoUrl: "", accentColor: "", theme: "", hiddenLocales: [] };

declare const globalThis: { cmsHiddenLocales?: Map<string, Promise<ReadonlySet<string>>>; cmsScopeThemes?: Map<string, Promise<string>> } & typeof global;
const hiddenCache = (globalThis.cmsHiddenLocales ??= new Map());
const themeCache = (globalThis.cmsScopeThemes ??= new Map());

/**
 * Languages the current scope value's site leaves out, read on every site request, so held in
 * memory per value and cleared when one is saved. Empty outside a value.
 */
export function hiddenLocalesHere(): Promise<ReadonlySet<string>> {
  const value = currentScopeValue();
  if (value === null) return Promise.resolve(new Set());
  let hit = hiddenCache.get(value);
  if (!hit) {
    if (hiddenCache.size > 5000) hiddenCache.clear();
    hit = readSiteIdentity().then((identity) => new Set(identity.hiddenLocales)).catch((error: unknown) => {
      hiddenCache.delete(value);
      throw error;
    });
    hiddenCache.set(value, hit);
  }
  return hit;
}

/** The current scope value's site identity, all empty outside one. A stored value that no longer parses counts as unset. */
export async function readSiteIdentity(): Promise<SiteIdentity> {
  const parsed = siteIdentitySchema.safeParse(await readScopedSetting(SITE_IDENTITY_KEY) ?? {});
  return parsed.success ? parsed.data : EMPTY;
}

export async function writeSiteIdentity(input: SiteIdentity, actorId: string): Promise<SiteIdentity> {
  const value = siteIdentitySchema.parse(input);
  await writeScopedSetting(SITE_IDENTITY_KEY, value, actorId);
  hiddenCache.clear();
  themeCache.clear();
  // Cached pages hold this value's name and its languages' addresses.
  invalidateSiteCache();
  return value;
}

/**
 * The theme the current scope value chose, by name, or "" for the build's default. Read on every
 * site request, so held in memory per value beside the hidden languages and cleared on a save.
 */
export function chosenThemeHere(): Promise<string> {
  const value = currentScopeValue();
  if (value === null) return Promise.resolve("");
  let hit = themeCache.get(value);
  if (!hit) {
    if (themeCache.size > 5000) themeCache.clear();
    hit = readSiteIdentity().then((identity) => identity.theme).catch((error: unknown) => {
      themeCache.delete(value);
      throw error;
    });
    themeCache.set(value, hit);
  }
  return hit;
}

/** The instance's branding with the scope value's own over it, where it set one. */
export function layerIdentity(instance: { appName: string; logoUrl: string; accentColor: string }, own: SiteIdentity) {
  return { name: own.name || instance.appName, logoUrl: own.logoUrl || instance.logoUrl, accentColor: own.accentColor || instance.accentColor };
}
