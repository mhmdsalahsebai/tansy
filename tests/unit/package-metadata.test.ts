/**
 * What every published package must carry before it can go to npm. The values come from
 * scripts/package-metadata.mjs, which writes them, so this fails when a new plugin or theme
 * is added and nobody ran it: `node scripts/package-metadata.mjs`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { metadataFor, outOfDate } from "../../scripts/package-metadata.mjs";
import { ROOT, extensionPackages, publishedPackages } from "../../scripts/workspace-packages.mjs";

const extensions = extensionPackages();
const published = publishedPackages();

describe("published packages", () => {
  it("has the plugins and themes this repository ships", () => {
    expect(extensions.length).toBeGreaterThan(50);
    expect(published).toHaveLength(extensions.length + 2);
  });

  it.each(extensions.map((pkg) => [pkg.folder, pkg] as const))("%s has current files, README and peer ranges", (_folder, pkg) => {
    expect(outOfDate(pkg), "run node scripts/package-metadata.mjs").toEqual([]);
  });

  it.each(published.map((pkg) => [pkg.folder, pkg] as const))("%s ships a licence, so npm shows one", (_folder, pkg) => {
    const file = path.join(ROOT, pkg.folder, "LICENSE");
    expect(existsSync(file), `${pkg.folder}/LICENSE is missing`).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(readFileSync(path.join(ROOT, "LICENSE"), "utf8"));
  });

  // "*" installs with any version of the CMS, so a plugin built for another major would load and fail at runtime.
  it.each(published.map((pkg) => [pkg.folder, pkg] as const))("%s pins its peers to a range", (_folder, pkg) => {
    for (const [name, range] of Object.entries(pkg.manifest.peerDependencies ?? {})) {
      expect(range, `${pkg.manifest.name} accepts any ${name}`).not.toBe("*");
      expect(range, `${pkg.manifest.name} declares ${name} as "${range}"`).toMatch(/^[\^~]?\d+\.\d+\.\d+/);
    }
  });

  it.each(published.map((pkg) => [pkg.folder, pkg] as const))("%s names only files that exist in its exports", (_folder, pkg) => {
    const targets = Object.values(pkg.manifest.exports ?? {}).flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry as Record<string, string>)));
    for (const target of targets) {
      if (target.includes("*")) continue;
      expect(existsSync(path.join(ROOT, pkg.folder, target)), `${pkg.manifest.name}: ${target}`).toBe(true);
    }
  });

  it.each(extensions.map((pkg) => [pkg.folder, pkg] as const))("%s ships every file its exports name", (_folder, pkg) => {
    const { files } = metadataFor(pkg);
    const extensionOf = (target: string) => target.slice(target.lastIndexOf("."));
    for (const target of Object.values(pkg.manifest.exports ?? {})) {
      if (typeof target !== "string") continue;
      const relative = target.replace(/^\.\//, "");
      const covered = files.some((entry) => entry === relative || entry === `*${extensionOf(relative)}` || relative.startsWith(`${entry}/`));
      expect(covered, `${pkg.manifest.name}: files doesn't cover ${target}`).toBe(true);
    }
  });

  it("keeps the repository's own packages out of the published metadata", () => {
    for (const pkg of extensions) {
      expect(pkg.manifest.private, `${pkg.manifest.name} is private and can't be published`).toBeUndefined();
      expect(pkg.manifest.repository?.directory, `${pkg.manifest.name} doesn't say which folder it comes from`).toBe(pkg.folder);
    }
  });
});
