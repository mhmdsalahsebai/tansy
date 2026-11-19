import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveRoutes, withCms } from "tansy/next";

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

describe("CMS paths", () => {
  it("are written only in lib/paths.ts, so changing routes reaches everything", () => {
    const sources = ["app", "components", "core", "lib"].flatMap((dir) => walk(path.join("packages/cms", dir))).filter((file) => /\.tsx?$/.test(file) && !file.endsWith("lib/paths.ts"));
    const literal = /(?<!Path\()["'`]\/(dashboard|api|signin|account)(?:["'`?]|\/(?!sign-|two-factor|email-otp|reset-password))/;
    const found = sources.flatMap((file) => readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && literal.test(line)).map((line) => `${file}: ${line.trim().slice(0, 100)}`));
    expect(found).toEqual([]);
  });

  it("follow the build's settings", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_TANSY_ADMIN_PATH", "/admin");
    vi.stubEnv("NEXT_PUBLIC_TANSY_API_PATH", "/cms-api");
    const { adminPath, apiPath, authPath, accountPath, needsSession } = await import("../../packages/cms/lib/paths");
    expect([adminPath("/users"), apiPath("/users"), authPath("signin"), accountPath("?denied=1")]).toEqual(["/admin/users", "/cms-api/users", "/admin/auth/signin", "/admin/account?denied=1"]);
    expect(needsSession("/admin")).toBe(true);
    expect(needsSession("/dashboard")).toBe(false);
    vi.unstubAllEnvs();
  });

  it("ask for a session everywhere under the admin path except sign-in", async () => {
    vi.resetModules();
    const { needsSession } = await import("../../packages/cms/lib/paths");
    for (const url of ["/dashboard", "/dashboard/users", "/dashboard/account", "/dashboard/authors"]) expect(needsSession(url), url).toBe(true);
    for (const url of ["/dashboard/auth/signin", "/dashboard/auth/setup", "/", "/about", "/dashboards"]) expect(needsSession(url), url).toBe(false);
  });
});

describe("withCms", () => {
  const cwd = path.resolve("apps/starter");

  it("refuses unsafe or overlapping paths", () => {
    for (const routes of [{ admin: "dashboard" }, { admin: "/" }, { admin: "/Admin" }, { admin: "/_next" }, { admin: "/a/../b" }, { admin: "/api" }, { api: "/dashboard/api" }]) expect(() => resolveRoutes(routes), JSON.stringify(routes)).toThrow(/routes/);
    expect(resolveRoutes()).toEqual({ admin: "/dashboard", api: "/api" });
  });

  it("refuses a setting whose folder doesn't exist, instead of serving nothing", () => {
    expect(() => withCms({}, { routes: { admin: "/admin" }, cwd })).toThrow(/doesn't exist/);
    expect(() => withCms({}, { cwd })).not.toThrow();
    // The first call loads the config reader, which takes seconds on a busy machine.
  }, 30_000);

  it("keeps the host's own config and rewrites, and adds what the CMS needs", async () => {
    const config = withCms({ transpilePackages: ["mine"], serverExternalPackages: ["sharp"], rewrites: async () => [{ source: "/a", destination: "/b" }] }, { cwd });
    expect(config.transpilePackages).toEqual(expect.arrayContaining(["tansy", "mine"]));
    expect(config.serverExternalPackages?.filter((name) => name === "sharp")).toHaveLength(1);
    expect(config.transpilePackages?.filter((name) => config.serverExternalPackages?.includes(name))).toEqual([]);
    const rewrites = await config.rewrites!() as { afterFiles: unknown[]; fallback: Array<{ destination: string }> };
    expect(rewrites.afterFiles).toContainEqual({ source: "/a", destination: "/b" });
    expect(rewrites.fallback[0].destination).toBe("/api/ext/:file");
    expect(config.env).toMatchObject({ NEXT_PUBLIC_TANSY_ADMIN_PATH: "/dashboard", NEXT_PUBLIC_TANSY_API_PATH: "/api" });
  });

  it("puts root files plugins declare ahead of a site's catch-all page, by exact name", async () => {
    const app = mkdtempSync(path.join(tmpdir(), "cms-root-files-"));
    mkdirSync(path.join(app, ".tansy"));
    mkdirSync(path.join(app, "app/(cms)/dashboard/(shell)"), { recursive: true });
    mkdirSync(path.join(app, "app/api/[...cms]"), { recursive: true });
    writeFileSync(path.join(app, ".tansy/manifest.json"), JSON.stringify({ packages: [], rootFiles: ["/sitemap.xml"] }));
    const rewrites = await withCms({}, { cwd: app }).rewrites!() as { afterFiles: unknown[] };
    expect(rewrites.afterFiles).toEqual([{ source: "/sitemap.xml", destination: "/api/ext/sitemap.xml" }]);
    rmSync(app, { recursive: true, force: true });
  });

  it("turns off prerendering, which can't carry a per-request nonce, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(withCms({ cacheComponents: true, partialPrefetching: true }, { cwd })).toMatchObject({ cacheComponents: false, partialPrefetching: false });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockClear();
    withCms({}, { cwd });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("adds base security headers, after which the host's own still apply", async () => {
    const mine = { source: "/embed", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] };
    const headers = await withCms({ headers: async () => [mine] }, { cwd }).headers!();
    expect(headers[0].headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    expect(headers.at(-1)).toEqual(mine);
  });
});
