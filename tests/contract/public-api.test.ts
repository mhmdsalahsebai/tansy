/**
 * The public API is what package.json's exports list, and it follows semver from 1.0.
 * A change to this snapshot is a change to that API, so it shows up in review.
 * See docs/contributing/deprecation.md for what a removal or a changed signature requires.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const PACKAGE = path.join(ROOT, "packages/cms");
const TYPE_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.WriteArrowStyleSignature;

interface Manifest {
  bin: Record<string, string>;
  exports: Record<string, string | { types: string }>;
  peerDependencies: Record<string, string>;
  engines: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8")) as Manifest;
const sourceOf = (target: string | { types: string }) => (typeof target === "string" ? target : target.types);
const isCode = (file: string) => /\.(d\.mts|tsx?)$/.test(file);

/** Paths differ between machines. Only the package-relative part means anything. */
const portable = (text: string) => text.replaceAll(`${ROOT}/`, "").replace(/import\("[^"]*node_modules\//g, 'import("');

function describeSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, at: ts.Node) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const isType = Boolean(target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias));
  if (!isType) return portable(checker.typeToString(checker.getTypeOfSymbolAtLocation(target, at), at, TYPE_FLAGS));
  const type = checker.getDeclaredTypeOfSymbol(target);
  const properties = checker.getPropertiesOfType(type);
  // One level of members, so adding, removing or retyping a property of a public interface is visible.
  if (!properties.length || type.isUnion()) return `type ${portable(checker.typeToString(type, at, TYPE_FLAGS | ts.TypeFormatFlags.InTypeAlias))}`;
  return Object.fromEntries(properties.map((property) => {
    const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
    return [`${property.name}${optional}`, portable(checker.typeToString(checker.getTypeOfSymbolAtLocation(property, at), at, TYPE_FLAGS))];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

function snapshot() {
  const entries = Object.entries(manifest.exports).map(([name, target]) => [name, sourceOf(target)] as const);
  const files = entries.filter(([, file]) => isCode(file)).map(([, file]) => path.join(PACKAGE, file));
  const { config } = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const program = ts.createProgram(files, { ...options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined });
  const checker = program.getTypeChecker();

  const api: Record<string, unknown> = {};
  for (const [name, file] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!isCode(file)) {
      api[name] = "files";
      continue;
    }
    const source = program.getSourceFile(path.join(PACKAGE, file));
    const entry = source && checker.getSymbolAtLocation(source);
    if (!source || !entry) throw new Error(`${name} has no module symbol.`);
    api[name] = Object.fromEntries(checker.getExportsOfModule(entry)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((symbol) => [symbol.name, describeSymbol(checker, symbol, source)]));
  }
  return { bin: Object.keys(manifest.bin).sort(), engines: manifest.engines, peerDependencies: manifest.peerDependencies, exports: api };
}

describe("public API", () => {
  it("matches the reviewed snapshot", async () => {
    await expect(`${JSON.stringify(snapshot(), null, 2)}\n`).toMatchFileSnapshot("./public-api.json");
  }, 120_000);
});
