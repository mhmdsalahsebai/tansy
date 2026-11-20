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
import { execFile, execFileSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, publishedPackages } from "./workspace-packages.mjs";

const RELEASE = path.join(ROOT, ".release");

/** Folders inside a package that build it rather than ship in it. */
const NOT_SHIPPED = new Set(["node_modules", "scripts", "dist", "tests"]);
/** What a manifest carries to npm. Scripts and dev dependencies are the repository's business. */
const PUBLISHED_KEYS = ["name", "version", "description", "keywords", "license", "author", "homepage", "repository", "bugs", "type", "bin", "exports", "engines", "peerDependencies", "peerDependenciesMeta", "dependencies"];

const CLIENT_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;

const TYPES = path.join(ROOT, "node_modules/@types");
const TSC = path.join(ROOT, "node_modules/typescript/bin/tsc");
/** Where the one compile of every plugin and theme lands, each in its own folder, before each is packed. */
const COMPILED = path.join(RELEASE, ".compiled");

/** How many `npm pack`s run at once. Each is a short node process; the compile is the slow part. */
const PACK_JOBS = Math.max(1, Math.min(availableParallelism(), 8));

const exec = promisify(execFile);

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
 * Compiles a set of plugins and themes in one tsc, with the same settings packages/cms is built
 * with, so a plugin compiles the way the CMS does. One program for many packages rather than one
 * per package: each plugin reaches the CMS's source through `tansy`, so a tsc per package
 * type-checked all of the CMS again, sixty times over, which took most of ten minutes. The files
 * a package reaches through node_modules, the CMS's and another plugin's, are checked but not
 * emitted. The output keeps the repository's layout under COMPILED, so each package's is its own folder.
 */
function compile(packages, name) {
  const config = path.join(RELEASE, `tsconfig.${name}.json`);
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
      rootDir: ROOT,
      outDir: COMPILED,
      // The config is written beside the output rather than inside the package, which is far enough
      // from node_modules that tsc stops picking up @types on its own. A declaration that reaches
      // Node's or React's types — a storage adapter reaches both — needs them named.
      typeRoots: [TYPES],
      types: installedTypes(),
    },
    // The ambient file declares the stylesheets and fonts a package imports for their effect. It emits nothing.
    include: [...packages.flatMap(({ folder }) => [`${path.join(ROOT, folder)}/**/*.ts`, `${path.join(ROOT, folder)}/**/*.tsx`]), path.join(import.meta.dirname, "package-assets.d.ts")],
    exclude: packages.flatMap(({ folder }) => [...NOT_SHIPPED].map((name) => `${path.join(ROOT, folder)}/${name}`)),
  }, null, 2)}\n`);
  execFileSync(process.execPath, [TSC, "-p", config], { cwd: ROOT, stdio: "inherit" });
}

/**
 * The packages asked for, in layers: those no other one depends on first, then the ones that
 * depend on them. A package another one imports, such as @tansy/ai for its providers, has to
 * be outside the program its dependents compile in. Inside it, tsc would name the base's types
 * by whichever of its entry points it met first, and a provider's declarations would say
 * import("@tansy/ai") where the published ones say import("@tansy/ai/provider").
 */
function layers(packages) {
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const depth = new Map();
  const depthOf = (name, seen = new Set()) => {
    if (depth.has(name)) return depth.get(name);
    if (seen.has(name)) throw new Error(`Packages depend on each other in a circle: ${[...seen, name].join(" -> ")}`);
    const { dependencies = {}, peerDependencies = {} } = byName.get(name).manifest;
    const inside = Object.keys({ ...dependencies, ...peerDependencies }).filter((dep) => names.has(dep));
    const value = inside.length ? 1 + Math.max(...inside.map((dep) => depthOf(dep, new Set([...seen, name])))) : 0;
    depth.set(name, value);
    return value;
  };
  const grouped = [];
  for (const pkg of packages) (grouped[depthOf(pkg.manifest.name)] ??= []).push(pkg);
  return grouped.filter(Boolean);
}

function compileAll(packages) {
  rmSync(COMPILED, { recursive: true, force: true });
  layers(packages).forEach((layer, index) => {
    console.log(`\n--- Compiling ${layer.length} package${layer.length === 1 ? "" : "s"} in one tsc: ${layer.map(({ manifest }) => manifest.name).join(", ")}`);
    compile(layer, `extensions-${index}`);
  });
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

/** Turns one package's share of the compile into the folder npm packs. */
function assembleExtension(pkg) {
  const out = path.join(RELEASE, pkg.folder);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const compiled = path.join(COMPILED, pkg.folder);
  if (existsSync(compiled)) cpSync(compiled, out, { recursive: true });
  copyAssets(pkg.folder, out);
  assertClientDirectives(pkg.folder, out);
  writeManifest(pkg, out);
  return out;
}

/** Output is kept, not streamed, so packs running side by side don't interleave theirs. */
async function pack(cwd) {
  try {
    const { stdout, stderr } = await exec("npm", ["pack", "--pack-destination", RELEASE, "--silent"], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    error.message = `npm pack failed in ${path.relative(ROOT, cwd)}\n${error.stdout ?? ""}${error.stderr ?? ""}`;
    throw error;
  }
}

/** Packs each folder, PACK_JOBS at a time. After a failure nothing new starts, and the first error is the one thrown. */
async function packAll(folders) {
  const queue = [...folders];
  let failure = null;
  const worker = async () => {
    for (let next = queue.shift(); next && !failure; next = queue.shift()) {
      try {
        console.log(`--- ${next.name}: ${await pack(next.folder)}`);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PACK_JOBS, folders.length) }, worker));
  if (failure) throw failure;
}

const buildCms = () => execFileSync("npm", ["run", "package", "-w", "tansy"], { cwd: ROOT, stdio: "inherit" });

async function main() {
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

  const extensions = chosen.filter(({ builder }) => builder === "tsc");
  if (extensions.length) compileAll(extensions);
  const folders = chosen.filter(({ builder }) => builder !== "own").map((pkg) => ({
    name: pkg.manifest.name,
    // Nothing to compile for a "copy" package: the folder is packed as it stands, with its own `files` deciding what goes in.
    folder: pkg.builder === "tsc" ? assembleExtension(pkg) : path.join(ROOT, pkg.folder),
  }));
  await packAll(folders);
  rmSync(COMPILED, { recursive: true, force: true });
  const built = readdirSync(RELEASE).filter((name) => name.endsWith(".tgz"));
  console.log(`\n${built.length} tarball${built.length === 1 ? "" : "s"} in .release/`);
}

await main();
