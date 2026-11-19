/**
 * Builds the site's reference pages from the repo's own markdown, so the docs have
 * one source: `docs/` in the repo root. Run it after changing anything under `docs/`.
 *
 *   npm --prefix apps/docs run sync        (or `npm run docs:sync` from the repo root)
 *
 * Pages written by hand — the landing page, getting started, and the plugin
 * overview and community pages — live in `content/docs` and are never touched.
 * The script owns `extending.md`, `guides/`, `themes/` and one file per plugin.
 */
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const repo = path.resolve(app, "../..");
const SRC = path.join(repo, "docs");
const OUT = path.join(app, "content/docs");

/** Folders with only generated pages, rewritten from scratch so a deleted page leaves no page behind. */
const OWNED_FOLDERS = ["guides"];

/** Where each source folder lands, and the order its pages take in the sidebar. */
const SECTIONS = [
  {
    dir: "guides",
    out: "guides",
    title: "Guides",
    order: ["content", "fields", "localization", "plugins", "themes", "search", "storage", "backups", "background-work", "production", "operations", "upgrading", "limits"],
  },
  {
    dir: "plugins",
    out: "plugins",
    title: "Plugins",
    // `index` and `community` are written by hand and sit around the generated pages.
    before: ["index"],
    after: ["community"],
    order: ["blog", "lms", "shop", "payments", "subscriptions", "forms", "newsletter", "email", "captcha", "ai", "analytics", "request-logs", "seo", "social-sign-in", "pwned-passwords", "multi-tenant"],
  },
  {
    dir: "themes",
    out: "themes",
    title: "Themes",
    before: ["index"],
    order: ["magazine", "storefront", "dispatch", "academy"],
  },
];

/** A source path, relative to docs/, and the page it becomes on the site. */
const URLS = new Map([["EXTENDING.md", "/docs/extending"]]);
for (const section of SECTIONS) {
  for (const slug of section.order) URLS.set(`${section.dir}/${slug}.md`, `/docs/${section.out}/${slug}`);
}

const warnings = [];

/** The first sentence or two of prose, for the page's description and its search result. */
function describe(body) {
  for (const block of body.split("\n\n")) {
    const text = block.trim();
    if (!text || /^[#|\-`>]/.test(text)) continue;
    const plain = text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return plain.length > 220 ? `${plain.slice(0, 217).replace(/[,;:\s]\S*$/, "")}…` : plain;
  }
  return "";
}

/** Links between the repo's markdown files become links between the site's pages. */
function relink(body, from) {
  return body.replace(/\]\(([^)\s]+\.md)(#[^)\s]*)?\)/g, (whole, target, anchor = "") => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
    const url = URLS.get(resolved);
    if (!url) {
      warnings.push(`${from}: link to ${target} has no page on the site, left as it is`);
      return whole;
    }
    return `](${url}${anchor})`;
  });
}

function frontmatter({ title, description }) {
  const quote = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines = [`title: ${quote(title)}`];
  if (description) lines.push(`description: ${quote(description)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

async function convert(relative) {
  const raw = await readFile(path.join(SRC, relative), "utf8");
  const match = raw.match(/^#\s+(.+)\n/);
  if (!match) throw new Error(`${relative} has no title heading`);
  const body = raw.slice(match[0].length).replace(/^\n+/, "");
  return `${frontmatter({ title: match[1].trim(), description: describe(body) })}\n${relink(body, relative)}`;
}

async function section({ dir, out, title, order, before = [], after = [] }) {
  const found = (await readdir(path.join(SRC, dir))).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
  const extra = found.filter((slug) => !order.includes(slug));
  if (extra.length) warnings.push(`${dir}/: ${extra.join(", ")} not in the sidebar order, added at the end`);
  const slugs = [...order.filter((slug) => found.includes(slug)), ...extra];
  await mkdir(path.join(OUT, out), { recursive: true });
  for (const slug of slugs) await writeFile(path.join(OUT, out, `${slug}.md`), await convert(`${dir}/${slug}.md`));
  const pages = [...before, ...slugs, ...after];
  await writeFile(path.join(OUT, out, "meta.json"), `${JSON.stringify({ title, pages }, null, 2)}\n`);
  return slugs.length;
}

async function main() {
  if (!existsSync(SRC)) throw new Error(`no ${SRC}: run this from inside the repo`);
  for (const folder of OWNED_FOLDERS) await rm(path.join(OUT, folder), { recursive: true, force: true });

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "extending.md"), await convert("EXTENDING.md"));
  let written = 1;
  for (const one of SECTIONS) written += await section(one);

  console.log(`sync-docs: wrote ${written} pages from docs/ into content/docs/`);
  for (const warning of warnings) console.warn(`  warning: ${warning}`);
}

await main();
