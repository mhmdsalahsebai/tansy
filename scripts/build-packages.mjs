/**
 * Builds the tarballs npm receives, for every published package:
 *
 *   node scripts/build-packages.mjs [<name or folder> ...]
 *
 * Writes .release/<name>-<version>.tgz. Publish those files, never a package folder: a
 * folder's `exports` point at TypeScript sources, and what npm gets is compiled.
 *
 * Each plugin and theme is compiled file by file into its own folder, in the same layout,
 * so a "use client" stays on its own file and a relative import of a stylesheet still
 * holds. `exports` are rewritten to the compiled file and its types. The CMS itself has a
 * build of its own (packages/cms/scripts/build-package.mjs), because it also ships Prisma
 * clients, migrations and styles; create-tansy is one plain JavaScript file and is
 * packed as it is.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, publishedPackages } from "./workspace-packages.mjs";

const RELEASE = path.join(ROOT, ".release");

/** Folders inside a package that build it rather than ship in it. */
const NOT_SHIPPED = new Set(["node_modules", "scripts", "dist", "tests"]);
/** What a manifest carries to npm. Scripts and dev dependencies are the repository's business. */
const PUBLISHED_KEYS = ["name", "version", "description", "keywords", "license", "author", "homepage", "repository", "bugs", "type", "bin", "exports", "engines", "peerDependencies", "peerDependenciesMeta", "dependencies"];

const CLIENT_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;

const TYPES = path.join(ROOT, "node_modules/@types");

/** Every @types package the workspace installed, which is what tsc would have included by itself. */
const installedTypes = () => readdirSync(TYPES).flatMap((name) => (name.startsWith("@") ? readdirSync(path.join(TYPES, name)).map((scoped) => `${name}/${scoped}`) : [name]));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (NOT_SHIPPED.has(entry.name)) return [];
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

const isSource = (file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts");

/** A source entry becomes its compiled file and its types. */
function compiledExport(target) {
  if (typeof target !== "string" || !isSource(target)) return target;
  const base = target.replace(/\.tsx?$/, "");
  return { types: `${base}.d.ts`, default: `${base}.js` };
}

const rewriteExports = (entries) =>
  Object.fromEntries(Object.entries(entries ?? {}).map(([key, target]) => [key, compiledExport(target)]));

/**
 * The manifest that goes with the tarball. `files` is left out on purpose: the folder being
 * packed was built for this and holds nothing else, while the source manifest's `files`
 * lists sources that aren't in here.
 */
function writeManifest(pkg, out) {
  const manifest = {};
  for (const key of PUBLISHED_KEYS) if (key in pkg.manifest) manifest[key] = pkg.manifest[key];
  manifest.exports = rewriteExports(pkg.manifest.exports);
  writeFileSync(path.join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** tsc keeps the directive today. The whole client/server split rests on it, so it's checked rather than assumed. */
function assertClientDirectives(folder, out) {
  for (const file of walk(path.join(ROOT, folder)).filter(isSource)) {
    if (!CLIENT_DIRECTIVE.test(readFileSync(file, "utf8"))) continue;
    const built = path.join(out, path.relative(path.join(ROOT, folder), file)).replace(/\.tsx?$/, ".js");
    if (!CLIENT_DIRECTIVE.test(readFileSync(built, "utf8"))) throw new Error(`${built} lost its "use client".`);
  }
}

/**
 * The same settings packages/cms is built with, so a plugin compiles the way the CMS does.
 * The config is written next to the output, and names the package by absolute path.
 */
function compile(folder, out) {
  const source = path.join(ROOT, folder);
  const config = path.join(RELEASE, `tsconfig.${folder.replaceAll("/", "-")}.json`);
  writeFileSync(config, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "dom.iterable", "esnext"],
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      isolatedModules: true,
      declaration: true,
      noEmitOnError: true,
      rootDir: source,
      outDir: out,
      // The config is written beside the output rather than inside the package, which is far enough
      // from node_modules that tsc stops picking up @types on its own. A declaration that reaches
      // Node's or React's types — a storage adapter reaches both — needs them named.
      typeRoots: [TYPES],
      types: installedTypes(),
    },
    // The ambient file declares the stylesheets and fonts a package imports for their effect. It emits nothing, so it can sit outside rootDir.
    include: [`${source}/**/*.ts`, `${source}/**/*.tsx`, path.join(import.meta.dirname, "package-assets.d.ts")],
    exclude: [...NOT_SHIPPED].map((name) => `${source}/${name}`),
  }, null, 2)}\n`);
  execFileSync("npx", ["tsc", "-p", config], { cwd: ROOT, stdio: "inherit" });
}

/** Everything tsc doesn't emit but the compiled files still reach: stylesheets, fonts, schema files, notices. */
function copyAssets(folder, out) {
  const source = path.join(ROOT, folder);
  for (const file of walk(source)) {
    const name = path.basename(file);
    if (isSource(file) || name === "package.json") continue;
    const target = path.join(out, path.relative(source, file));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(file, target);
  }
}

function buildExtension(pkg) {
  const out = path.join(RELEASE, pkg.folder);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  compile(pkg.folder, out);
  copyAssets(pkg.folder, out);
  assertClientDirectives(pkg.folder, out);
  writeManifest(pkg, out);
  execFileSync("npm", ["pack", "--pack-destination", RELEASE, "--silent"], { cwd: out, stdio: "inherit" });
}

/** Nothing to compile: the folder is packed as it stands, with its own `files` deciding what goes in. */
function packAsIs(pkg) {
  execFileSync("npm", ["pack", "--pack-destination", RELEASE, "--silent"], { cwd: path.join(ROOT, pkg.folder), stdio: "inherit" });
}

const buildCms = () => execFileSync("npm", ["run", "package", "-w", "tansy"], { cwd: ROOT, stdio: "inherit" });

function main() {
  const asked = process.argv.slice(2);
  const all = publishedPackages();
  const chosen = asked.length ? all.filter(({ folder, manifest }) => asked.includes(folder) || asked.includes(manifest.name)) : all;
  if (asked.length && chosen.length !== asked.length) {
    const found = new Set(chosen.flatMap(({ folder, manifest }) => [folder, manifest.name]));
    throw new Error(`Not a published package: ${asked.filter((name) => !found.has(name)).join(", ")}`);
  }
  // The CMS's own build empties .release first, so it goes before anything else when it is in the list.
  const cms = chosen.find(({ builder }) => builder === "own");
  if (cms) buildCms();
  else mkdirSync(RELEASE, { recursive: true });

  for (const pkg of chosen.filter(({ builder }) => builder !== "own")) {
    console.log(`\n--- ${pkg.manifest.name}`);
    if (pkg.builder === "tsc") buildExtension(pkg);
    else packAsIs(pkg);
  }
  const built = readdirSync(RELEASE).filter((name) => name.endsWith(".tgz"));
  console.log(`\n${built.length} tarball${built.length === 1 ? "" : "s"} in .release/`);
}

main();
