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

/** What a peer range should be: a workspace package's current minor, or the range the CMS uses. */
export function peerRangeFor(name) {
  const versions = workspaceVersions();
  if (versions[name]) return `^${versions[name]}`;
  const shared = sharedPeerRanges();
  if (shared[name]) return shared[name];
  return null;
}
