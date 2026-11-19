import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rootPackage from "../../package.json";
import starterPackage from "../../apps/starter/package.json";
import cmsPackage from "../../packages/cms/package.json";

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

const STYLES = "packages/cms/styles";
const sheets = readdirSync(STYLES).map((name) => path.join(STYLES, name));
const css = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const defined = new Set(sheets.flatMap((file) => [...css(file).matchAll(/\.(cms-[a-z0-9-]+)/g)].map((match) => match[1])));
const sources = ["apps/starter/app", "packages/cms/app", "packages/cms/components", "examples"].flatMap(walk).filter((file) => /\.tsx?$/.test(file));

/** Splits a selector list on its outer commas, leaving those inside :where() alone. */
function topLevel(list: string) {
  const parts = [""];
  let depth = 0;
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts.map((part) => part.trim());
}

describe("styles", () => {
  it("use logical properties, so right to left mirrors", () => {
    // Centring at 50% reads the same either way, so it's the one physical offset allowed.
    const physical = /(?:margin|padding|border)-(?:left|right)\b|(?<![-\w])(?:left|right)\s*:\s*(?!50%)|text-align:\s*(?:left|right)\b|float:\s*(?:left|right)\b|translateX\((?!calc\([^)]*var\(--cms-dir)(?!-50%)/;
    for (const file of sheets) {
      css(file).split("\n").forEach((line, index) => expect(line, `${file}:${index + 1}`).not.toMatch(physical));
    }
  });

  it("have no Tailwind", () => {
    const names = Object.keys({ ...rootPackage.devDependencies, ...starterPackage.dependencies, ...cmsPackage.dependencies, ...cmsPackage.peerDependencies });
    expect(names.filter((name) => name.includes("tailwind"))).toEqual([]);
    for (const file of sheets) expect(css(file), file).not.toMatch(/@apply|@theme|@import ["']tailwindcss/);
  });

  it("are all inside a layer, apart from the import list and keyframes", () => {
    for (const file of sheets.filter((name) => !name.endsWith("admin.css"))) {
      const top = css(file).replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").trim();
      expect(top, file).toMatch(/^@layer cms\.[a-z]+ \{/);
      expect(top.endsWith("}"), file).toBe(true);
      expect(top.match(/^@layer /gm), file).toHaveLength(1);
    }
  });

  it("only select their own classes, so they can't reach a host site", () => {
    for (const file of sheets.filter((name) => !name.endsWith("admin.css"))) {
      const selectors = [...css(file).matchAll(/(?:^|[{}])\s*([^{}@]+?)\s*\{/g)].map((match) => match[1].trim());
      for (const list of selectors) {
        for (const selector of topLevel(list)) {
          if (selector === ":root" || /^(from|to|\d+%)$/.test(selector)) continue;
          expect(selector, file).toContain(".cms-");
        }
      }
    }
  });

  it("define every class the code uses", () => {
    // A component the dashboard's sheets never reach, such as the site's admin bar, carries its own
    // rules in a `<style>`: the classes and custom properties those rules declare count as defined there.
    const ownRules = (text: string) => new Set([...text.matchAll(/`([^`]*\{[^`]*\})`/g)].flatMap((sheet) => [...sheet[1].matchAll(/(?:\.|var\(--)(cms-[a-z0-9-]+)/g)].map((match) => match[1])));
    const missing = sources.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const own = ownRules(text);
      return [...text.matchAll(/\bcms-[a-z][a-z0-9-]*[a-z0-9]\b(?![.\w-])/g)].map((match) => match[0]).filter((name) => !defined.has(name) && !own.has(name)).map((name) => `${file}: ${name}`);
    });
    expect(missing).toEqual([]);
  });
});
