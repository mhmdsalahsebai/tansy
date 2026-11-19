/**
 * Publishes the tarballs in .release/ to npm:
 *
 *   node scripts/build-packages.mjs
 *   node scripts/publish-packages.mjs [--dry-run] [--tag <dist-tag>]
 *
 * A release moves 62 packages at once, so this is written to be run again after a failure:
 * a version already on the registry is skipped, not retried. `tansy` goes first, since
 * everything else declares it as a peer and create-tansy installs them together.
 *
 * It refuses to start unless every package is at the same version — scripts/set-version.mjs
 * is what moves them — and it never touches a package folder: only the built tarball is
 * published, because a folder's `exports` point at TypeScript sources.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ROOT, publishedPackages } from "./workspace-packages.mjs";

const RELEASE = path.join(ROOT, ".release");
const dryRun = process.argv.includes("--dry-run");
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? "latest" : process.argv[tagIndex + 1];

if (!tag) throw new Error("--tag needs a dist-tag, such as latest or next.");
if (!existsSync(RELEASE)) throw new Error("No .release folder. Run node scripts/build-packages.mjs first.");

/** npm names a tarball after the package and version it holds, with the scope flattened. */
const tarballName = ({ name, version }) => `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;

/** Published already? Then this run is a retry of a release that stopped halfway. */
function onRegistry(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version", "--silent"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const compare = (a, b) => {
  const [x, y] = [a, b].map((value) => value.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

const packages = publishedPackages();
const version = packages.find(({ kind }) => kind === "cms").manifest.version;
// A package may be ahead of the CMS — set-version never lowers one, so a plugin that had to move
// faster stays ahead until the shared version catches up. One left behind is a release that forgot it.
const behind = packages.filter(({ manifest }) => compare(manifest.version, version) < 0);
if (behind.length) {
  throw new Error(`${behind.map(({ manifest }) => `${manifest.name} is at ${manifest.version}`).join(", ")}, behind tansy at ${version}. Run node scripts/set-version.mjs ${version} first.`);
}
const ahead = packages.filter(({ manifest }) => manifest.version !== version);

// Tansy first, then the plugins, then the themes that use them, then the scaffolder that installs the lot.
const order = { cms: 0, plugin: 1, theme: 2, tool: 3 };
const ordered = [...packages].sort((a, b) => order[a.kind] - order[b.kind] || a.manifest.name.localeCompare(b.manifest.name));

const missing = ordered.filter(({ manifest }) => !existsSync(path.join(RELEASE, tarballName(manifest))));
if (missing.length) {
  throw new Error(`No tarball for ${missing.map(({ manifest }) => manifest.name).join(", ")}. Run node scripts/build-packages.mjs.`);
}

console.log(`${ordered.length} packages, ${version} except ${ahead.length ? ahead.map(({ manifest }) => `${manifest.name} at ${manifest.version}`).join(", ") : "none"}, as ${tag}${dryRun ? " (dry run)" : ""}.\n`);
const published = [];
const skipped = [];
for (const { manifest } of ordered) {
  const tarball = path.join(RELEASE, tarballName(manifest));
  if (onRegistry(manifest.name, manifest.version)) {
    skipped.push(manifest.name);
    console.log(`= ${manifest.name}@${manifest.version} is already on npm`);
    continue;
  }
  // Provenance links the tarball to the workflow run that built it, which npm shows on the package
  // page. It needs the workflow's OIDC token, so it is asked for only where there is one.
  const provenance = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : [];
  const args = ["publish", tarball, "--access", "public", ...provenance, "--tag", tag, ...(dryRun ? ["--dry-run"] : [])];
  execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });
  published.push(manifest.name);
}

console.log(`\n${dryRun ? "Would publish" : "Published"} ${published.length}, skipped ${skipped.length} already on npm.`);
if (readdirSync(RELEASE).filter((name) => name.endsWith(".tgz")).length !== ordered.length) {
  console.warn("Note: .release holds tarballs that aren't part of this release. It is rebuilt from scratch by the builder.");
}
