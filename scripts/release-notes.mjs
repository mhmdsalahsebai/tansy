/**
 * Prints one release's section of its package's changelog, for a GitHub release's body:
 *
 *   node scripts/release-notes.mjs @tansy/blog@0.1.2 > notes.md
 *
 * Each plugin and theme keeps its own CHANGELOG.md in its folder, since each moves on its own
 * version. `tansy` and create-tansy use the one at the root, which also holds the releases from
 * before that, when every package moved together (`v0.1.1` still finds those).
 *
 * The changelog is the one place a release is described, so the release page quotes it rather
 * than restating it. A version with no entry is a mistake worth stopping for.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { publishedPackages, ROOT } from "./workspace-packages.mjs";

const release = process.argv[2] ?? "";
const match = /^(?:(@?[^@]+)@|v)(\d+\.\d+\.\d+\S*)$/.exec(release);
if (!match) {
  console.error("Usage: node scripts/release-notes.mjs <package>@<version>");
  process.exit(1);
}
const [, name, version] = match;
const pkg = name ? publishedPackages().find(({ manifest }) => manifest.name === name) : undefined;
if (name && !pkg) {
  console.error(`${name} isn't a package this repository publishes.`);
  process.exit(1);
}

const file = !pkg || pkg.kind === "cms" || pkg.kind === "tool" ? "CHANGELOG.md" : `${pkg.folder}/CHANGELOG.md`;
const changelog = existsSync(path.join(ROOT, file)) ? readFileSync(path.join(ROOT, file), "utf8") : "";
const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b.*$`, "m");
const start = changelog.search(heading);
if (start === -1) {
  console.error(`${file} has no "## ${version}" entry. Add one before tagging.`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## /m);
const body = (next === -1 ? rest : rest.slice(0, next + 1)).trim();
// The heading itself is the release's own title on GitHub, so only the body is printed.
console.log(body.split("\n").slice(1).join("\n").trim());
