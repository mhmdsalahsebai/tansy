/**
 * Sets one version across the workspace, because a release moves 62 published packages at once:
 *
 *   node scripts/set-version.mjs 1.0.0 [--dry-run]
 *
 * For each package it writes `version` in package.json, the same number in the `definePlugin` or
 * `defineTheme` literal in its index.ts (the runtime reads that one, and a mismatch is a bug
 * `tests/unit/plugin-manifest.test.ts` fails on), and `requires: { cms: "^<version>" }` wherever a
 * plugin declares it. `TANSY_VERSION` in packages/cms/core/version.ts moves with them. It finishes by
 * running scripts/package-metadata.mjs, because each published package's peer ranges name the
 * version of the workspace package it depends on.
 *
 * It never lowers a version: `core/extend/lifecycle.ts` refuses to start a plugin older than the
 * one a database was last upgraded to, so going down would break existing installs. Anything
 * already higher than the target is left alone and listed at the end.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const [target, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

if (!/^\d+\.\d+\.\d+$/.test(target ?? "")) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch> [--dry-run]");
  process.exit(1);
}

const compare = (a, b) => {
  const [x, y] = [a, b].map((value) => value.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

const folders = [
  ...["plugins", "themes", "examples"].flatMap((group) => readdirSync(path.join(ROOT, group)).map((name) => `${group}/${name}`)),
  "packages/cms",
  "packages/create-tansy",
  "apps/starter",
  ".",
];

const kept = [];
const changed = [];
const write = (file, text) => (dryRun ? undefined : writeFileSync(file, text));

for (const folder of folders) {
  const manifestFile = path.join(ROOT, folder, "package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const higher = compare(manifest.version, target) > 0;

  if (higher) kept.push(`${manifest.name} stays ${manifest.version}`);
  else if (manifest.version !== target) {
    write(manifestFile, readFileSync(manifestFile, "utf8").replace(`"version": "${manifest.version}"`, `"version": "${target}"`));
    changed.push(`${manifest.name} ${manifest.version} -> ${target}`);
  }

  // The version the runtime reads, and the CMS range the plugin accepts.
  const entry = path.join(ROOT, folder, "index.ts");
  let source;
  try {
    source = readFileSync(entry, "utf8");
  } catch {
    continue;
  }
  const declared = source.match(/(?<![A-Za-z])version: "(\d+\.\d+\.\d+)"/g) ?? [];
  if (declared.length > 1) throw new Error(`${folder}/index.ts declares ${declared.length} versions. Set them by hand.`);
  let updated = source;
  if (declared.length === 1 && !higher) updated = updated.replace(/(?<![A-Za-z])version: "\d+\.\d+\.\d+"/, `version: "${target}"`);
  updated = updated.replace(/(requires: \{ cms: ")\^?\d+\.\d+\.\d+(")/, `$1^${target}$2`);
  // A range written some other way would be missed silently, and the plugin would then refuse this CMS.
  const range = /requires:\s*\{[^}]*cms:\s*"([^"]+)"/.exec(updated)?.[1];
  if (range !== undefined && range !== `^${target}`) throw new Error(`${folder}/index.ts requires cms "${range}", which this script can't rewrite. Set it to "^${target}" by hand.`);
  if (updated !== source) {
    write(entry, updated);
    if (!changed.some((line) => line.startsWith(`${manifest.name} `))) changed.push(`${manifest.name} index.ts`);
  }
}

const versionFile = path.join(ROOT, "packages/cms/core/version.ts");
const version = readFileSync(versionFile, "utf8");
const bumped = version.replace(/TANSY_VERSION = "\d+\.\d+\.\d+"/, `TANSY_VERSION = "${target}"`);
if (bumped !== version) {
  write(versionFile, bumped);
  changed.push(`TANSY_VERSION -> ${target}`);
}

console.log(`${dryRun ? "Would set" : "Set"} ${target} in ${changed.length} place${changed.length === 1 ? "" : "s"}:`);
for (const line of changed) console.log(`  ${line}`);
if (kept.length) console.log(`\nLeft alone, being newer than ${target}:\n${kept.map((line) => `  ${line}`).join("\n")}`);
// Peer ranges name a workspace package's own version, so they follow from the versions just written.
if (!dryRun) execFileSync(process.execPath, [path.join(ROOT, "scripts/package-metadata.mjs")], { stdio: "inherit" });

console.log(`\nNext: npm install (to refresh the lockfile), then npm run check.`);
