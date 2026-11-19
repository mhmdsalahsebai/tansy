/**
 * Prints one release's section of CHANGELOG.md, for a GitHub release's body:
 *
 *   node scripts/release-notes.mjs v0.1.0 > notes.md
 *
 * The changelog is the one place a release is described, so the release page quotes it rather
 * than restating it. A version with no entry is a mistake worth stopping for.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./workspace-packages.mjs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}

const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b.*$`, "m");
const start = changelog.search(heading);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" entry. Add one before tagging.`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## /m);
const body = (next === -1 ? rest : rest.slice(0, next + 1)).trim();
// The heading itself is the release's own title on GitHub, so only the body is printed.
console.log(body.split("\n").slice(1).join("\n").trim());
