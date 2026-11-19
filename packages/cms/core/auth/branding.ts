import "server-only";
import { getCmsConfig } from "../config";
import { adminThemeStyles } from "../theme/tokens";
import { getRuntime } from "./instance";

/** What every page shows. A problem here must never stop a page rendering. */
export async function loadBranding() {
  try {
    return (await getRuntime()).settings.general;
  } catch {
    return { appName: "Tansy", logoUrl: "", accentColor: "" };
  }
}

/** The admin's logo: the one set under Settings, or the admin theme's. */
export async function loadAdminBranding() {
  const branding = await loadBranding();
  return { ...branding, logoUrl: branding.logoUrl || (getCmsConfig().adminTheme?.logo ?? "") };
}

/** The admin theme's tokens as a stylesheet. Each value was checked by defineAdminTheme and is filtered again here. */
export function adminThemeCss() {
  const theme = getCmsConfig().adminTheme;
  return theme ? adminThemeStyles(theme.tokens) : null;
}

/** The shades the interface uses, derived from one colour. The schema only lets a hex value through. */
export function accentStyles(color: string) {
  if (!color) return null;
  const mix = (other: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, ${other})`;
  return `:root{--cms-color-accent-surface:${mix("white", 8)};--cms-color-accent-tint:${mix("white", 18)};--cms-color-accent-border-soft:${mix("white", 70)};--cms-color-accent-border:${mix("white", 88)};--cms-color-accent:${color};--cms-color-accent-hover:${mix("black", 85)};--cms-color-accent-strong:${mix("black", 70)};--cms-color-on-accent:white}`;
}
