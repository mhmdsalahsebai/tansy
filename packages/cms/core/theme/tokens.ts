/**
 * Theme tokens become CSS custom properties in a <style> tag, so every value is checked
 * against the shape its group allows. Nothing free-form reaches the page: none of the
 * patterns accept ";", "{", "}", "<" or a url().
 *
 * No imports, because a headless site runs this too.
 */
const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|oklch|oklab)\((?:\s*-?\d+(?:\.\d+)?(?:%|deg)?\s*[,/]?){3,4}\s*\))$/i;
const LENGTH = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|ch|vw|vh|%))$/;
const FAMILY = String.raw`(?:var\(--[a-z0-9-]+\)|"[A-Za-z0-9 _-]+"|'[A-Za-z0-9 _-]+'|[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)*)`;
const FONT = new RegExp(`^${FAMILY}(?:,\\s*${FAMILY})*$`);
const SHADOW_LENGTH = String.raw`-?\d+(?:\.\d+)?(?:px|rem|em)?`;
const SHADOW_COLOR = String.raw`(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,/%]+\))`;
const SHADOW = new RegExp(`^(?:none|${SHADOW_LENGTH}(?: ${SHADOW_LENGTH}){1,3} ${SHADOW_COLOR})$`, "i");

const MAX_VALUE = 240;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const TOKEN_GROUPS = { color: COLOR, font: FONT, space: LENGTH, radius: LENGTH, size: LENGTH, shadow: SHADOW } as const;

export type TokenGroup = keyof typeof TOKEN_GROUPS;
export type ThemeTokens = Partial<Record<TokenGroup, Record<string, string>>>;

const isGroup = (group: string): group is TokenGroup => Object.hasOwn(TOKEN_GROUPS, group);

export function validToken(group: TokenGroup, value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VALUE && TOKEN_GROUPS[group].test(value);
}

/** Why these tokens can't be used, naming the first bad one. */
export function tokensProblem(tokens: ThemeTokens): string | null {
  for (const [group, values] of Object.entries(tokens)) {
    if (!isGroup(group)) return `unknown token group "${group}". Use ${Object.keys(TOKEN_GROUPS).join(", ")}.`;
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!NAME.test(name)) return `token name "${group}.${name}" must be lowercase letters, digits and hyphens.`;
      if (!validToken(group, value)) return `token "${group}.${name}" has a value that isn't a valid ${group}: ${JSON.stringify(value)}.`;
    }
  }
  return null;
}

/** Declarations for a site's tokens, such as --site-color-accent:#2f6f5e;. Anything invalid is left out, as this also runs on values read back from the API. */
export function siteTokenDeclarations(tokens: ThemeTokens, accent?: string | null) {
  const declarations = Object.entries(tokens).flatMap(([group, values]) =>
    isGroup(group) ? Object.entries(values ?? {}).filter(([name, value]) => NAME.test(name) && validToken(group, value)).map(([name, value]) => `--site-${group}-${name}:${value};`) : []);
  // Last, so the accent set under Settings wins over the theme's.
  if (accent && validToken("color", accent)) declarations.push(`--site-color-accent:${accent};`);
  return declarations.join("");
}

export type AdminTokens = Record<string, string>;

const adminGroup = (name: string) => Object.keys(TOKEN_GROUPS).find((group) => name.startsWith(`${group}-`)) as TokenGroup | undefined;
const ADMIN_NAME = /^[a-z][a-z0-9-]{0,59}$/;

/** Why these admin tokens can't be used. Names are the --cms- tokens without that prefix, such as "color-surface". */
export function adminTokensProblem(tokens: AdminTokens): string | null {
  for (const [name, value] of Object.entries(tokens)) {
    const group = adminGroup(name);
    if (!ADMIN_NAME.test(name) || !group) return `token "${name}" must start with one of ${Object.keys(TOKEN_GROUPS).map((g) => `${g}-`).join(", ")}.`;
    if (!validToken(group, value)) return `token "${name}" has a value that isn't a valid ${group}: ${JSON.stringify(value)}.`;
  }
  return null;
}

const adminDeclarations = (tokens: AdminTokens) => Object.entries(tokens).filter(([name, value]) => {
  const group = adminGroup(name);
  return ADMIN_NAME.test(name) && group && validToken(group, value);
}).map(([name, value]) => `--cms-${name}:${value};`).join("");

/** The admin's stylesheet for a theme, or null when it sets nothing. */
export function adminThemeStyles({ light = {}, dark = {} }: { light?: AdminTokens; dark?: AdminTokens }) {
  const lightRules = adminDeclarations(light);
  const darkRules = adminDeclarations(dark);
  if (!lightRules && !darkRules) return null;
  return `${lightRules ? `:root{${lightRules}}` : ""}${darkRules ? `@media (prefers-color-scheme: dark){:root{${darkRules}}}` : ""}`;
}
