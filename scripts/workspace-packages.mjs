/**
 * The packages this repository publishes, and what each one is.
 *
 * One list, so the metadata script, the builder, the release workflow and the tests that
 * check all three can't drift apart.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

/** Folders whose packages are published, and the kind of thing each one is. */
const GROUPS = [
  { dir: "plugins", kind: "plugin" },
  { dir: "themes", kind: "theme" },
];

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const manifestOf = (folder) => readJson(path.join(ROOT, folder, "package.json"));

/**
 * Every published package: the CMS, the scaffolder, and each plugin and theme.
 *
 * `builder: "own"` means the package brings its own build script, as the CMS does —
 * it ships Prisma clients, styles and migrations, which a generic build knows nothing about.
 * `builder: "copy"` means nothing to compile.
 */
export function publishedPackages() {
  const generated = GROUPS.flatMap(({ dir, kind }) =>
    readdirSync(path.join(ROOT, dir))
      .filter((name) => existsSync(path.join(ROOT, dir, name, "package.json")))
      .map((name) => ({ folder: `${dir}/${name}`, slug: name, kind, builder: "tsc", manifest: manifestOf(`${dir}/${name}`) })),
  );
  return [
    { folder: "packages/cms", slug: "cms", kind: "cms", builder: "own", manifest: manifestOf("packages/cms") },
    { folder: "packages/create-tansy", slug: "create-tansy", kind: "tool", builder: "copy", manifest: manifestOf("packages/create-tansy") },
    ...generated,
  ];
}

/** The plugins and themes: one shape, one build, one set of rules. */
export const extensionPackages = () => publishedPackages().filter(({ builder }) => builder === "tsc");

/** The version each workspace package is at, for writing peer ranges that mean something. */
export function workspaceVersions() {
  return Object.fromEntries(publishedPackages().map(({ manifest }) => [manifest.name, manifest.version]));
}

/**
 * Peer ranges every package shares. The CMS's own peers and its better-auth dependency
 * decide them, so one upgrade there doesn't leave sixty manifests behind.
 */
export function sharedPeerRanges() {
  const cms = manifestOf("packages/cms");
  return {
    next: cms.peerDependencies.next,
    react: cms.peerDependencies.react,
    "react-dom": cms.peerDependencies["react-dom"],
    "better-auth": cms.dependencies["better-auth"],
  };
}

/** Plugins, themes and the CMS each move on their own version, so ranges are checked rather than assumed. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((value) => value.split(/[.-]/).slice(0, 3).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Whether `version` is in `range`, for the ranges this repository writes: `^x.y.z`, `~x.y.z` or an
 * exact `x.y.z`. Caret follows npm before 1.0 too, where `^0.1.2` stops short of 0.2.0.
 */
export function satisfies(version, range) {
  const match = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [, op, ...floor] = match;
  const [major, minor, patch] = version.split(".").map(Number);
  const [m, n] = floor.map(Number);
  if (compareVersions(version, floor.join(".")) < 0) return false;
  if (op === "") return version === floor.join(".");
  if (op === "~") return major === m && minor === n;
  if (m > 0) return major === m;
  if (n > 0) return major === 0 && minor === n;
  return major === 0 && minor === 0 && patch === Number(floor[2]);
}

/** The CMS range a plugin or theme declares in its index.ts, which the runtime enforces. */
export function requiredCms(folder) {
  const entry = path.join(ROOT, folder, "index.ts");
  if (!existsSync(entry)) return null;
  return /requires:\s*\{[^}]*cms:\s*"([^"]+)"/.exec(readFileSync(entry, "utf8"))?.[1] ?? null;
}

/**
 * What a package's peer range on `name` should be.
 *
 * On `tansy`, the CMS range its index.ts requires, so npm and the runtime agree. On another workspace
 * package, the range it has while that still includes the package's current version, and the
 * current version's caret range once it doesn't: a range moves when the package it names leaves it,
 * not every time that package releases. Otherwise the range the CMS uses for the same dependency.
 */
export function peerRangeFor(name, { folder, current } = {}) {
  if (name === "tansy" && folder) {
    const required = requiredCms(folder);
    if (required) return required;
  }
  const versions = workspaceVersions();
  if (versions[name]) return current && satisfies(versions[name], current) ? current : `^${versions[name]}`;
  const shared = sharedPeerRanges();
  if (shared[name]) return shared[name];
  return null;
}
