import { getCmsConfig } from "../config";
import type { CmsConfig } from "../auth/extensions";
import type { ThemeManifest } from "./define";

/**
 * The themes a build has. `theme` is one theme, `themes` several, and a config sets one or the
 * other: both together would leave no answer to which is the default. The first of `themes` is
 * the default, so a site that chooses nothing serves the same pages it did with one theme.
 *
 * Several themes exist so a scope value can pick its own (C29): the choice is a per-scope
 * setting, not a config entry, because a build ships the themes and a tenant picks among them.
 */
export function installedThemes(config: CmsConfig = getCmsConfig()): ThemeManifest[] {
  const { theme, themes } = config;
  if (theme && themes?.length) throw new Error("tansy.config.ts sets both theme and themes. Use themes for several, or theme for one.");
  const list = theme ? [theme] : themes ?? [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (seen.has(entry.name)) throw new Error(`Theme "${entry.name}" is listed twice in themes.`);
    seen.add(entry.name);
  }
  return list;
}

/** The theme a site serves when it has chosen none, or null in a build with no theme at all. */
export const defaultTheme = (config?: CmsConfig): ThemeManifest | null => installedThemes(config)[0] ?? null;

/**
 * The theme a name picks, or the default one. An unknown name falls back rather than throwing,
 * because a theme can leave a build after a site chose it, and a visitor should still get a page.
 */
export function themeNamed(name: string | null | undefined, config?: CmsConfig): ThemeManifest | null {
  const themes = installedThemes(config);
  return (name ? themes.find((theme) => theme.name === name) : undefined) ?? themes[0] ?? null;
}
