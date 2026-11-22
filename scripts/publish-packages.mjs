/**
 * Publishes releases from the tarballs in .release/ to npm:
 *
 *   node scripts/build-packages.mjs
 *   node scripts/publish-packages.mjs [--dry-run] [--tag <dist-tag>] [<name>@<version> ...]
 *
 * Without --tag, a version goes out as `latest`, or `next` for a prerelease such as 0.2.0-beta.0.
 *   node scripts/publish-packages.mjs --pending <name>@<version> ...
 *
 * Every package moves on its own version, and a release names the packages it publishes, as the
 * git tags on a release commit do (`@tansy/blog@0.1.2`). Each must be the version this checkout
 * holds. With none named, it publishes every package whose version isn't on npm yet. `--pending`
 * only prints the named releases npm doesn't have yet, one per line, after the same checks, and
 * publishes nothing.
 *
 * It is written to be run again after a failure: a version already on the registry is skipped,
 * not retried. `tansy` goes first, since everything else declares it as a peer. A package whose
 * workspace peers have no published version in its range is refused, because it would install
 * against nothing: release the peer in the same run, or first.
 *
 * It never touches a package folder: only the built tarball is published, because a folder's
 * `exports` point at TypeScript sources.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, publishedPackages, satisfies } from "./workspace-packages.mjs";

const RELEASE = path.join(ROOT, ".release");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const pendingOnly = argv.includes("--pending");
const tagIndex = argv.indexOf("--tag");
const tag = tagIndex === -1 ? null : argv[tagIndex + 1];
if (tag === undefined || tag?.startsWith("--")) throw new Error("--tag needs a dist-tag, such as latest or next.");
/** The dist-tag a version goes out under: the one asked for, or `next` for a prerelease so a plain install never picks it up. */
const distTag = (version) => tag ?? (version.includes("-") ? "next" : "latest");
const named = argv.filter((arg, index) => !arg.startsWith("--") && (tagIndex === -1 || index !== tagIndex + 1));

/** npm names a tarball after the package and version it holds, with the scope flattened. */
const tarballName = ({ name, version }) => `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;

/** Versions of `name` on npm that are in `range`, or none. */
function published(name, range) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${range}`, "version", "--json"], { stdio: "pipe" }).toString().trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

const onRegistry = (name, version) => published(name, version).includes(version);

const packages = publishedPackages();
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));

/** The packages this run is about: those named, each checked against the checkout, or every unpublished one. */
function requested() {
  if (!named.length) return packages.filter(({ manifest }) => !onRegistry(manifest.name, manifest.version));
  return named.map((release) => {
    const match = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release);
    if (!match) throw new Error(`"${release}" isn't a release. Name one as <package>@<version>, such as @tansy/blog@0.1.2.`);
    const [, name, version] = match;
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`${name} isn't a package this repository publishes.`);
    if (pkg.manifest.version !== version) throw new Error(`The release says ${name}@${version} and the checkout has ${pkg.manifest.version}. Run node scripts/set-version.mjs ${name} ${version}, or tag the commit that has it.`);
    return pkg;
  });
}

const releases = requested().filter(({ manifest }) => !onRegistry(manifest.name, manifest.version));

// Tansy first, then the plugins, then the themes that use them, then the scaffolder that installs the lot.
const order = { cms: 0, plugin: 1, theme: 2, tool: 3 };
const ordered = [...releases].sort((a, b) => order[a.kind] - order[b.kind] || a.manifest.name.localeCompare(b.manifest.name));

const unmet = ordered.flatMap(({ manifest }) =>
  Object.entries(manifest.peerDependencies ?? {})
    .filter(([peer]) => byName.has(peer))
    .filter(([peer, range]) => {
      const alongside = ordered.find((other) => other.manifest.name === peer);
      if (alongside && satisfies(alongside.manifest.version, range)) return false;
      return published(peer, range).length === 0;
    })
    .map(([peer, range]) => `${manifest.name} needs ${peer}@${range}, which isn't on npm`),
);
if (unmet.length) throw new Error(`${unmet.join("; ")}. Release it in the same run, or first.`);

// The workflow asks this first, so a release that can't go out stops before the build and tests.
if (pendingOnly) {
  for (const { manifest } of ordered) console.log(`${manifest.name}@${manifest.version}`);
  process.exit(0);
}

const missing = ordered.filter(({ manifest }) => !existsSync(path.join(RELEASE, tarballName(manifest))));
if (missing.length) {
  throw new Error(`No tarball for ${missing.map(({ manifest }) => manifest.name).join(", ")}. Run node scripts/build-packages.mjs.`);
}

if (!ordered.length) console.log("Nothing to publish: every release named is on npm already.");
else console.log(`${dryRun ? "Would publish" : "Publishing"} ${ordered.map(({ manifest }) => `${manifest.name}@${manifest.version} as ${distTag(manifest.version)}`).join(", ")}.\n`);
const done = [];
for (const { manifest } of ordered) {
  const tarball = path.join(RELEASE, tarballName(manifest));
  // Provenance links the tarball to the workflow run that built it, which npm shows on the package
  // page. It needs the workflow's OIDC token, so it is asked for only where there is one.
  const provenance = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : [];
  const npmArgs = ["publish", tarball, "--access", "public", ...provenance, "--tag", distTag(manifest.version), ...(dryRun ? ["--dry-run"] : [])];
  execFileSync("npm", npmArgs, { cwd: ROOT, stdio: "inherit" });
  done.push(`${manifest.name}@${manifest.version}`);
}

// The workflow makes a GitHub release for each of these.
if (existsSync(RELEASE)) writeFileSync(path.join(RELEASE, "published.txt"), done.map((line) => `${line}\n`).join(""));
console.log(`\n${dryRun ? "Would have published" : "Published"} ${done.length}.`);
