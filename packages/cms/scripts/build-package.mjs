/**
 * Builds what npm receives, in .release/package: every source file compiled on its own,
 * in the same layout, so each "use client" stays on its own file and relative paths to
 * styles and migrations still hold. The workspace itself keeps running from source.
 *
 * Writes .release/tansy-<version>.tgz. Publish that file, never this folder.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateClients } from "./prisma-generate.mjs";

const PACKAGE = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PACKAGE, "../..");
const RELEASE = path.join(ROOT, ".release");
const OUTPUT = path.join(RELEASE, "package");
const COMPILED_FOLDERS = ["app", "components", "core", "entry", "lib", "routes", "sdk", "types"];
// Scripts that build the package rather than run inside it. Everything else in scripts/ ships,
// so a new file the CLI imports is in the tarball without anyone remembering to list it.
const BUILD_ONLY = new Set(["build-package.mjs", "db-migrate.mjs", "generate-route-table.mjs", "prisma-generate.mjs"]);
const SHIPPED_SCRIPTS = readdirSync(path.join(PACKAGE, "scripts")).filter((name) => name.endsWith(".mjs") && !BUILD_ONLY.has(name)).map((name) => `scripts/${name}`);
const COPIED = ["styles", "prisma", "generated", "prisma.config.ts", ...SHIPPED_SCRIPTS];

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

/** A source entry becomes its compiled file and its types. */
function compiledExport(target) {
  if (typeof target !== "string" || !/\.tsx?$/.test(target)) return target;
  const base = target.replace(/\.tsx?$/, "");
  return { types: `${base}.d.ts`, default: `${base}.js` };
}

function writeManifest() {
  const { name, version, description, keywords, license, author, homepage, repository, bugs, bin, exports: entries, peerDependencies, dependencies, engines } = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
  // `private` is left out on purpose: the workspace keeps it so this folder can't be published by hand, and only the tarball may go to npm.
  const manifest = { name, version, description, keywords, license, author, homepage, repository, bugs, bin, exports: Object.fromEntries(Object.entries(entries).map(([key, target]) => [key, compiledExport(target)])), engines, peerDependencies, dependencies };
  writeFileSync(path.join(OUTPUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The CLI is plain JavaScript, so nothing type-checks its imports: a script it loads and the
 * tarball doesn't hold would only fail in someone else's app, as `tansy init` did once.
 */
function assertScriptImports() {
  for (const entry of SHIPPED_SCRIPTS) {
    const source = readFileSync(path.join(OUTPUT, entry), "utf8");
    for (const [, target] of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*\.mjs)["']/g)) {
      const resolved = path.join(path.dirname(path.join(OUTPUT, entry)), target);
      if (!existsSync(resolved)) throw new Error(`${entry} imports ${target}, which isn't in the package. Add it to scripts/, or to BUILD_ONLY if it only builds.`);
    }
  }
}

/** tsc keeps directives today. The whole client/server split rests on it, so it's checked rather than assumed. */
function assertClientDirectives() {
  const directive = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
  for (const folder of COMPILED_FOLDERS) {
    for (const file of walk(path.join(PACKAGE, folder)).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))) {
      if (!directive.test(readFileSync(file, "utf8"))) continue;
      const built = path.join(OUTPUT, path.relative(PACKAGE, file)).replace(/\.tsx?$/, ".js");
      if (!directive.test(readFileSync(built, "utf8"))) throw new Error(`${built} lost its "use client".`);
    }
  }
}

generateClients();
rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: PACKAGE, stdio: "inherit" });
for (const entry of COPIED) {
  mkdirSync(path.dirname(path.join(OUTPUT, entry)), { recursive: true });
  cpSync(path.join(PACKAGE, entry), path.join(OUTPUT, entry), { recursive: true });
}
// Whatever tsc doesn't emit but the compiled files still reach, such as fonts and the plain-JavaScript entry.
for (const folder of COMPILED_FOLDERS) {
  for (const file of walk(path.join(PACKAGE, folder)).filter((f) => !/\.tsx?$/.test(f) || f.endsWith(".d.ts"))) {
    const target = path.join(OUTPUT, path.relative(PACKAGE, file));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(file, target);
  }
}
if (existsSync(path.join(ROOT, "README.md"))) cpSync(path.join(ROOT, "README.md"), path.join(OUTPUT, "README.md"));
// npm shows the licence on the package page only when the file itself is in the tarball.
cpSync(path.join(ROOT, "LICENSE"), path.join(OUTPUT, "LICENSE"));
assertClientDirectives();
assertScriptImports();
writeManifest();
execFileSync("npm", ["pack", "--pack-destination", RELEASE, "--silent"], { cwd: OUTPUT, stdio: "inherit" });
