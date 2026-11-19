/**
 * The dashboard's design pattern, see docs/contributing/design-system.md. Colors, like every other value a
 * theme may change, are tokens: component styles name a token and never a literal color, so
 * the dark theme, an administrator's accent and a theme's overrides reach every component.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = path.resolve(__dirname, "../../packages/cms/styles");
const COMPONENT_STYLES = ["base.css", "components.css", "editor.css", "utilities.css"];
// color-mix() of tokens is fine, so it isn't listed. "white" alone, not in white-space.
const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(|(?<![\w-])(?:white|black)(?![\w-])/gi;

/** A rule's declarations, with comments, selectors and token fallbacks such as var(--x, #fff) left out. */
function declarations(css: string) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .flatMap((line) => line.match(/\{([^{}]*)\}/g) ?? [])
    .map((block) => block.slice(1, -1));
}

describe("design system", () => {
  it.each(COMPONENT_STYLES)("%s takes its colors from tokens", (file) => {
    const css = readFileSync(path.join(STYLES, file), "utf8");
    const literals = declarations(css).flatMap((body) => [...body.matchAll(COLOR)].map((match) => `${match[0]} in { ${body.trim().slice(0, 80)} }`));
    expect(literals).toEqual([]);
  });
});
