/**
 * Moves one published package to a new version:
 *
 *   node scripts/set-version.mjs <package> <version> [--dry-run]
 *   node scripts/set-version.mjs @tansy/blog 0.1.2
 *
 * Every package moves on its own version, so only the one that changed is released. `<package>` is
 * its npm name or its folder (`plugins/blog`). It writes `version` in package.json, the same number
 * in the `definePlugin` or `defineTheme` literal in its index.ts (the runtime reads that one, and a
 * mismatch is a bug `tests/unit/plugin-manifest.test.ts` fails on), and for `tansy` itself
 * `TANSY_VERSION` in packages/cms/core/version.ts. It finishes by running
 * scripts/package-metadata.mjs, which moves a dependent's peer range only if the new version has
 * left it, and refreshes the version table create-tansy installs from.
 *
 * It never touches `requires: { cms }`: that is each plugin's own statement of the CMS it works
 * with. When `tansy` moves out of a plugin's range, it lists the plugins to release with a wider one.
 *
 * It never lowers a version: `core/extend/lifecycle.ts` refuses to start a plugin older than the
 * one a database was last upgraded to, so going down would break existing installs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareVersions, publishedPackages, requiredCms, ROOT, satisfies } from "./workspace-packages.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [wanted, target] = args.filter((arg) => !arg.startsWith("--"));

if (!wanted || !/^\d+\.\d+\.\d+$/.test(target ?? "")) {
  console.error("Usage: node scripts/set-version.mjs <package> <major.minor.patch> [--dry-run]");
  process.exit(1);
}

const packages = publishedPackages();
const pkg = packages.find(({ manifest, folder }) => manifest.name === wanted || folder === wanted.replace(/\/$/, ""));
if (!pkg) {
  console.error(`No published package is called ${wanted}. Give its npm name, such as @tansy/blog, or its folder.`);
  process.exit(1);
}
const { name, version: current } = pkg.manifest;
if (compareVersions(target, current) <= 0) {
  console.error(`${name} is at ${current}. A release only moves forward, so give a version above it.`);
  process.exit(1);
}

const changed = [];
const write = (file, from, to) => {
  if (from === to) return;
  if (!dryRun) writeFileSync(file, to);
  changed.push(path.relative(ROOT, file));
};

const manifestFile = path.join(ROOT, pkg.folder, "package.json");
const manifestText = readFileSync(manifestFile, "utf8");
write(manifestFile, manifestText, manifestText.replace(`"version": "${current}"`, `"version": "${target}"`));

const entry = path.join(ROOT, pkg.folder, "index.ts");
if (pkg.kind !== "cms" && existsSync(entry)) {
  const source = readFileSync(entry, "utf8");
  const declared = source.match(/(?<![A-Za-z])version: "(\d+\.\d+\.\d+)"/g) ?? [];
  if (declared.length > 1) throw new Error(`${pkg.folder}/index.ts declares ${declared.length} versions. Set them by hand.`);
  write(entry, source, source.replace(/(?<![A-Za-z])version: "\d+\.\d+\.\d+"/, `version: "${target}"`));
}

if (pkg.kind === "cms") {
  const versionFile = path.join(ROOT, "packages/cms/core/version.ts");
  const source = readFileSync(versionFile, "utf8");
  write(versionFile, source, source.replace(/TANSY_VERSION = "\d+\.\d+\.\d+"/, `TANSY_VERSION = "${target}"`));
}

console.log(`${dryRun ? "Would move" : "Moved"} ${name} from ${current} to ${target}${changed.length ? `, in ${changed.join(", ")}` : ""}.`);

// A plugin's CMS range is its own to widen, once someone has checked it works with the new CMS.
if (pkg.kind === "cms") {
  const behind = packages.filter(({ folder }) => {
    const range = requiredCms(folder);
    return range && !satisfies(target, range);
  });
  if (behind.length) {
    console.log(`\nThese require a CMS range without ${target}. Check each against it, widen its requires.cms, and release it too:`);
    for (const { manifest, folder } of behind) console.log(`  ${manifest.name} requires ${requiredCms(folder)}`);
  }
}

// Dependents' peer ranges and create-tansy's table follow from the version just written.
if (!dryRun) execFileSync(process.execPath, [path.join(ROOT, "scripts/package-metadata.mjs")], { stdio: "inherit" });

const changelog = pkg.kind === "cms" ? "CHANGELOG.md" : `${pkg.folder}/CHANGELOG.md`;
console.log(`
Next:
  1. Describe it under "## ${target}" in ${changelog}. The release page quotes that entry.
  2. npm install, to refresh the lockfile, then npm run check.
  3. Commit, then tag the commit ${name}@${target} and push the tag. The release workflow publishes it.`);
