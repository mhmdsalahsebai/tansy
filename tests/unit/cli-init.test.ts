import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.resolve("packages/cms/scripts/tansy.mjs");
const dirs: string[] = [];

function freshApp() {
  const cwd = mkdtempSync(path.join(tmpdir(), "cms-init-"));
  dirs.push(cwd);
  writeFileSync(path.join(cwd, "package.json"), "{}");
  mkdirSync(path.join(cwd, "app"));
  writeFileSync(path.join(cwd, "app/layout.tsx"), `import "./globals.css";\nexport default function L() { return null; }\n`);
  writeFileSync(path.join(cwd, "app/page.tsx"), `import styles from "./page.module.css";\nexport default function P() { return styles.x; }\n`);
  writeFileSync(path.join(cwd, "app/globals.css"), "");
  writeFileSync(path.join(cwd, "app/page.module.css"), "");
  writeFileSync(path.join(cwd, "app/favicon.ico"), "");
  writeFileSync(path.join(cwd, "next.config.ts"), `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`);
  return cwd;
}

const cms = (cwd: string, ...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
const read = (cwd: string, file: string) => readFileSync(path.join(cwd, file), "utf8");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tansy init", () => {
  it("moves the site beside the admin, so each has its own root layout", () => {
    const cwd = freshApp();
    cms(cwd, "init");
    for (const file of ["layout.tsx", "page.tsx", "globals.css", "page.module.css"]) {
      expect(existsSync(path.join(cwd, "app/(site)", file)), file).toBe(true);
      expect(existsSync(path.join(cwd, "app", file)), file).toBe(false);
    }
    expect(existsSync(path.join(cwd, "app/favicon.ico"))).toBe(true);
    expect(existsSync(path.join(cwd, "app/(cms)/layout.tsx"))).toBe(true);
    expect(read(cwd, "app/(site)/layout.tsx")).toContain('export const dynamic = "force-dynamic"');
    // The site keeps the home page.
    expect(existsSync(path.join(cwd, "app/(cms)/page.tsx"))).toBe(false);
  });

  it("writes every entry file with imports that need no tsconfig alias", () => {
    const cwd = freshApp();
    cms(cwd, "init");
    expect(read(cwd, "app/(cms)/dashboard/(shell)/[[...cms]]/page.tsx")).toContain('from "../../../../../tansy.config"');
    expect(read(cwd, "app/(cms)/dashboard/(public)/auth/[...cms]/page.tsx")).toContain('from "../../../../../../tansy.config"');
    expect(read(cwd, "app/api/[...cms]/route.ts")).toContain('from "../../../tansy.config"');
    expect(read(cwd, "app/api/[...cms]/route.ts")).toContain("createApiHandlers(config)");
    expect(read(cwd, "proxy.ts")).toContain("api/files/upload$");
    expect(read(cwd, "proxy.ts")).toContain('from "./.tansy/csp"');
    expect(read(cwd, "next.config.ts")).toContain("export default withCms(nextConfig);");
    expect(read(cwd, ".tansy/admin.ts")).toContain("plugins: []");
    expect(read(cwd, ".tansy/csp.ts")).toContain("const allAdditions = {}");
    expect(read(cwd, ".gitignore")).toContain(".tansy/");
    for (const retired of ["cms.admin.tsx", "cms.admin.client.ts", "cms.csp.ts"]) expect(existsSync(path.join(cwd, retired)), retired).toBe(false);
  });

  it("writes no secret into anything but .env, and a fresh one each time", () => {
    const [a, b] = [freshApp(), freshApp()];
    cms(a, "init");
    cms(b, "init");
    const secret = (cwd: string) => /BETTER_AUTH_SECRET="([^"]+)"/.exec(read(cwd, ".env"))![1];
    expect(secret(a)).not.toBe(secret(b));
    expect(secret(a).length).toBeGreaterThanOrEqual(32);
  });

  it("changes nothing when run again, and never replaces .env", () => {
    const cwd = freshApp();
    cms(cwd, "init");
    writeFileSync(path.join(cwd, "tansy.config.ts"), "// mine");
    const env = read(cwd, ".env");
    const config = read(cwd, "next.config.ts");
    const output = cms(cwd, "init");
    expect(read(cwd, "tansy.config.ts")).toBe("// mine");
    expect(read(cwd, ".env")).toBe(env);
    expect(read(cwd, "next.config.ts")).toBe(config);
    expect(output).toContain("Kept the existing .env");
  });

  it("follows custom paths, in the folders and the settings", () => {
    const cwd = freshApp();
    cms(cwd, "init", "--admin", "/admin", "--api", "/cms-api");
    expect(existsSync(path.join(cwd, "app/(cms)/admin/(shell)/layout.tsx"))).toBe(true);
    expect(existsSync(path.join(cwd, "app/cms-api/[...cms]/route.ts"))).toBe(true);
    expect(read(cwd, "next.config.ts")).toContain('withCms(nextConfig, { routes: {"admin":"/admin","api":"/cms-api"} })');
    expect(read(cwd, "proxy.ts")).toContain("cms-api/files/upload$");
  });

  it("uses src/ when the app does, for the files Next.js looks for there", () => {
    const cwd = freshApp();
    mkdirSync(path.join(cwd, "src"));
    execFileSync("mv", [path.join(cwd, "app"), path.join(cwd, "src/app")]);
    cms(cwd, "init");
    expect(read(cwd, "src/proxy.ts")).toContain('from "../.tansy/csp"');
    expect(existsSync(path.join(cwd, "src/instrumentation.ts"))).toBe(true);
    expect(existsSync(path.join(cwd, "src/app/(site)/layout.tsx"))).toBe(true);
  });

  it("leaves what it can't change safely, and says what to do", () => {
    const cwd = freshApp();
    writeFileSync(path.join(cwd, "next.config.ts"), "module.exports = {};\n");
    writeFileSync(path.join(cwd, "proxy.ts"), "export const proxy = () => undefined;\n");
    writeFileSync(path.join(cwd, "app/layout.tsx"), `import "../outside.css";\nexport default function L() { return null; }\n`);
    const output = cms(cwd, "init");
    expect(read(cwd, "next.config.ts")).toBe("module.exports = {};\n");
    expect(read(cwd, "proxy.ts")).toBe("export const proxy = () => undefined;\n");
    expect(existsSync(path.join(cwd, "app/layout.tsx"))).toBe(true);
    expect(output).toMatch(/Wrap the config in next\.config\.ts/);
    expect(output).toMatch(/createCmsProxy/);
    expect(output).toMatch(/Move app\/layout/);
  });

  it("refuses a path that isn't one", () => {
    expect(() => cms(freshApp(), "init", "--admin", "admin/../x")).toThrow();
  });
});

describe("tansy sync", () => {
  const plugin = (extra: object) => JSON.stringify({ name: "acme", version: "1.2.0", apiVersion: 1, ...extra });
  const withConfig = (...plugins: string[]) => {
    const cwd = freshApp();
    cms(cwd, "init");
    writeFileSync(path.join(cwd, "tansy.config.ts"), `export default { plugins: [${plugins.join(",")}], csp: { img: ["https://site.test"] } };\n`);
    return cwd;
  };

  it("turns a plugin's module names into import maps, kept apart for server, browser and proxy", () => {
    const cwd = withConfig(plugin({ admin: { server: "@acme/cms/admin", client: "@acme/cms/client" }, csp: { frame: ["https://a.test"] } }));
    cms(cwd, "sync");
    const server = read(cwd, ".tansy/admin.ts");
    const client = read(cwd, ".tansy/admin.client.ts");
    const csp = read(cwd, ".tansy/csp.ts");
    expect(server).toContain('from "@acme/cms/admin"');
    expect(server).not.toContain("@acme/cms/client");
    expect(client).toContain('from "@acme/cms/client"');
    expect(client).not.toContain("@acme/cms/admin");
    expect(csp).toContain("https://a.test");
    expect(csp).toContain("https://site.test");
    expect(csp).not.toMatch(/^import /m);
    expect(JSON.parse(read(cwd, ".tansy/manifest.json")).packages).toEqual(["@acme/cms"]);
    expect(read(cwd, ".tansy/theme.ts")).toContain("components: ThemeComponents | null = null");
    // The editor loads the site's components lazily, and only frames what the policy allows.
    expect(client).toContain('export const sitePreview = () => import("./preview");');
    const preview = read(cwd, ".tansy/preview.ts");
    expect(preview).toContain('import renderers from "./render";');
    expect(preview).toContain("theme: null");
    expect(preview).toContain('frames: ["https://a.test"]');
  });

  it("imports the theme's components and transpiles its package, leaving the manifest free of React", () => {
    const cwd = freshApp();
    cms(cwd, "init");
    writeFileSync(path.join(cwd, "tansy.config.ts"), `export default { theme: { name: "acme", version: "1.0.0", apiVersion: 1, render: "@acme/theme/render" }, plugins: [${plugin({ routes: [{ method: "GET", path: "/robots.txt", root: true, access: "public", reason: "x" }] })}] };\n`);
    cms(cwd, "sync");
    expect(read(cwd, ".tansy/theme.ts")).toContain('from "@acme/theme/render"');
    expect(read(cwd, ".tansy/preview.ts")).toContain('import theme from "@acme/theme/render";');
    expect(JSON.parse(read(cwd, ".tansy/manifest.json"))).toEqual({ packages: ["@acme/theme"], rootFiles: ["/robots.txt"] });
  });

  it("refuses a theme whose render path isn't a module path", () => {
    const cwd = freshApp();
    cms(cwd, "init");
    writeFileSync(path.join(cwd, "tansy.config.ts"), `export default { theme: { name: "acme", render: '"; evil("' } };\n`);
    expect(() => cms(cwd, "sync")).toThrow();
  });

  it("adds a site page on request, without taking over an existing home page", () => {
    const empty = freshApp();
    rmSync(path.join(empty, "app/page.tsx"));
    cms(empty, "init", "--site");
    expect(read(empty, "app/(site)/[[...path]]/page.tsx")).toContain("createSitePage");
    expect(read(empty, "app/(site)/layout.tsx")).toContain("force-dynamic");
    expect(existsSync(path.join(empty, "app/(cms)/page.tsx"))).toBe(false);

    const hosted = freshApp();
    cms(hosted, "init");
    cms(hosted, "init", "--site");
    expect(existsSync(path.join(hosted, "app/(site)/[[...path]]/page.tsx"))).toBe(false);
    expect(read(hosted, "app/(site)/[...path]/page.tsx")).toContain("createSitePage");
  });

  it("writes a module beside the app relative to .cms", () => {
    const cwd = withConfig(plugin({ admin: { server: "./local/admin" } }));
    cms(cwd, "sync");
    expect(read(cwd, ".tansy/admin.ts")).toContain('from "../local/admin"');
  });

  it("refuses anything that isn't a module path, because it's written into source", () => {
    const cwd = withConfig(plugin({ admin: { server: 'x"; process.exit(1); "' } }));
    expect(() => cms(cwd, "sync")).toThrow();
    expect(read(cwd, ".tansy/admin.ts")).not.toContain("process.exit");
  });

  it("refuses a Content Security Policy source that isn't an exact origin", () => {
    for (const bad of ["*", "'unsafe-inline'", "https://a.test/path"]) {
      expect(() => cms(withConfig(plugin({ csp: { frame: [bad] } })), "sync"), bad).toThrow();
    }
  });

  it("tells when the maps no longer match the config, and leaves unchanged files alone", () => {
    const cwd = withConfig(plugin({ admin: { server: "@acme/cms/admin" } }));
    expect(() => cms(cwd, "sync", "--check")).toThrow();
    cms(cwd, "sync");
    expect(cms(cwd, "sync", "--check")).toContain("up to date");
    expect(cms(cwd, "sync")).toContain("up to date");
  });

  it("prints every route a plugin adds, with its access", () => {
    const route = { method: "GET", path: "/stats", access: "permission", permission: "ext.acme:read" };
    const cwd = withConfig(plugin({ routes: [route], permissions: { "ext.acme": ["read"] } }));
    const output = cms(cwd, "routes");
    expect(output).toContain("acme 1.2.0");
    expect(output).toContain("/api/ext/acme/stats");
    expect(output).toContain("permission ext.acme:read");
    expect(output).toContain("ext.acme:read");
  });
});

describe("tansy doctor", () => {
  it("reports what's wrong and exits non-zero", () => {
    let output = "";
    try {
      cms(freshApp(), "doctor");
    } catch (error) {
      output = (error as { stdout: string }).stdout;
    }
    expect(output).toContain("FAIL  next.config wraps withCms");
    expect(output).toContain("FAIL  BETTER_AUTH_SECRET");
  });
});
