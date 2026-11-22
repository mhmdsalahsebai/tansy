import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../packages/cms/scripts/doctor.mjs";
import { PLUGIN_API_VERSION as scaffoldPlugin, THEME_API_VERSION as scaffoldTheme, newField, newPlugin, newTheme } from "../../packages/cms/scripts/scaffold.mjs";
import { VERSIONS } from "../../packages/create-tansy/index.mjs";
import { cmsConfig, dependenciesFor, packageManager, parsePlugin, pluginsFor, problems } from "../../packages/create-tansy/plan.mjs";
import { PACKAGES } from "../../packages/create-tansy/versions.mjs";
import { PLUGIN_API_VERSION } from "../../packages/cms/core/extend/define";
import { THEME_API_VERSION } from "../../packages/cms/core/theme/define";
import { clearDirectoryCache, loadDirectory } from "../../packages/cms/core/extend/directory";

const CREATE = path.resolve("packages/create-tansy/index.mjs");
const dirs: string[] = [];

function folder() {
  const cwd = mkdtempSync(path.join(tmpdir(), "cms-scaffold-"));
  dirs.push(cwd);
  return cwd;
}

const read = (cwd: string, file: string) => readFileSync(path.join(cwd, file), "utf8");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("generators", () => {
  it("stay on the API versions the CMS provides", () => {
    expect(scaffoldPlugin).toBe(PLUGIN_API_VERSION);
    expect(scaffoldTheme).toBe(THEME_API_VERSION);
  });

  it("write a plugin that can be published and found", () => {
    const cwd = folder();
    newPlugin({ cwd, name: "my-notes", packageName: "@acme/notes" });
    const pkg = JSON.parse(read(cwd, "plugins/my-notes/package.json"));
    expect(pkg.name).toBe("@acme/notes");
    expect(pkg.private).toBeUndefined();
    expect(pkg.keywords).toContain("tansy-plugin");
    expect(read(cwd, "plugins/my-notes/index.ts")).toContain('admin: { client: "@acme/notes/client", render: "@acme/notes/render" }');
    // Field types and blocks have to start with the plugin's name, with hyphens as underscores.
    expect(read(cwd, "plugins/my-notes/fields/note/index.ts")).toContain('type: "my_notes_note"');
    expect(read(cwd, "plugins/my-notes/index.ts")).toContain('name: "my_notes_note_card"');
  });

  it("add a field without touching anything an author wrote", () => {
    const cwd = folder();
    newPlugin({ cwd, name: "acme" });
    const index = read(cwd, "plugins/acme/index.ts");
    newField({ cwd, name: "star-rating", plugin: "plugins/acme" });
    expect(read(cwd, "plugins/acme/index.ts")).toBe(index);
    expect(read(cwd, "plugins/acme/fields/star-rating/index.ts")).toContain('type: "acme_star_rating"');
    expect(read(cwd, "plugins/acme/fields/index.ts")).toContain("export const fields = [noteField, starRatingField];");
    expect(read(cwd, "plugins/acme/fields/client.ts")).toContain("[noteAdmin, starRatingAdmin]");
    expect(read(cwd, "plugins/acme/fields/render.ts")).toContain("...noteRenderers, ...starRatingRenderers");
  });

  it("write a theme whose config entry holds no React", () => {
    const cwd = folder();
    newTheme({ cwd, name: "acme" });
    expect(JSON.parse(read(cwd, "themes/acme/package.json")).keywords).toContain("tansy-theme");
    expect(read(cwd, "themes/acme/index.ts")).toContain('render: "cms-theme-acme/render"');
    expect(read(cwd, "themes/acme/index.ts")).not.toContain("react");
  });

  it.each(["Bad", "1bad", "has space", 'a"; process.exit(1); "', "../up", ""])("refuse the name %j", (name) => {
    expect(() => newPlugin({ cwd: folder(), name })).toThrow(/lowercase/);
    expect(() => newTheme({ cwd: folder(), name })).toThrow(/lowercase/);
  });

  it("refuse an unsafe package name", () => {
    expect(() => newPlugin({ cwd: folder(), name: "ok", packageName: 'x"; evil()' })).toThrow(/valid npm package/);
  });

  it("never write into a folder that has something in it", () => {
    const cwd = folder();
    mkdirSync(path.join(cwd, "plugins/acme"), { recursive: true });
    writeFileSync(path.join(cwd, "plugins/acme/keep.txt"), "mine");
    expect(() => newPlugin({ cwd, name: "acme" })).toThrow(/isn't empty/);
    expect(read(cwd, "plugins/acme/keep.txt")).toBe("mine");
  });

  it("refuse a field outside a generated plugin, a repeated one, or one whose type would be too long", () => {
    const cwd = folder();
    expect(() => newField({ cwd, name: "x" })).toThrow(/tansy plugin new/);
    newPlugin({ cwd, name: "acme" });
    expect(() => newField({ cwd, name: "note", plugin: "plugins/acme" })).toThrow(/already exists/);
    expect(() => newField({ cwd, name: "a".repeat(38), plugin: "plugins/acme" })).toThrow(/longer than/);
  });
});

describe("create-tansy", () => {
  const create = (cwd: string, ...args: string[]) => execFileSync(process.execPath, [CREATE, ...args, "--no-install"], { cwd, encoding: "utf8", stdio: "pipe" });

  it("uses the framework versions tansy asks for", () => {
    const { peerDependencies } = JSON.parse(readFileSync("packages/cms/package.json", "utf8"));
    expect(VERSIONS).toEqual(peerDependencies);
  });

  it("installs each package at its own version, not create-tansy's", () => {
    const cwd = folder();
    create(cwd, "site", "--template", "blog");
    const { dependencies } = JSON.parse(read(cwd, "site/package.json"));
    for (const name of ["tansy", "@tansy/theme-blog", "@tansy/blog"] as const) expect(dependencies[name], name).toBe(`^${PACKAGES[name]}`);
    expect(() => dependenciesFor({ template: "headless" }, {})).toThrow(/no version for tansy/);
  });

  it("gives the same-app templates a theme, and leaves the rest to tansy init", () => {
    const cwd = folder();
    create(cwd, "site", "--template", "blog");
    expect(read(cwd, "site/tansy.config.ts")).toContain("theme: blog()");
    expect(JSON.parse(read(cwd, "site/package.json")).dependencies["@tansy/theme-blog"]).toBeDefined();
    expect(existsSync(path.join(cwd, "site/proxy.ts"))).toBe(false);
  });

  it("still takes the old template names, as a site with that theme", () => {
    const cwd = folder();
    create(cwd, "site", "--template", "blank");
    expect(read(cwd, "site/tansy.config.ts")).toContain("theme: blank()");
    expect(JSON.parse(read(cwd, "site/package.json")).scripts.tansy).toBe("tansy");
  });

  it("writes the plugins, providers and storage asked for, with their packages", () => {
    const cwd = folder();
    create(cwd, "shop", "--theme", "storefront", "--payments", "polar", "--storage", "s3", "--plugins", "email:postmark,forms");
    const config = read(cwd, "shop/tansy.config.ts");
    expect(config).toContain("payments({ siteUrl, providers: [polar()] })");
    expect(config).toContain("email({ providers: [postmark()] })");
    expect(config).toContain("env.S3_BUCKET");
    // Payments comes before the shop that sells through it.
    expect(config.indexOf("payments({")).toBeLessThan(config.indexOf("shop({"));
    const { dependencies } = JSON.parse(read(cwd, "shop/package.json"));
    for (const name of ["@tansy/theme-storefront", "@tansy/payments", "@tansy/payments-polar", "@tansy/shop", "@tansy/email", "@tansy/email-postmark", "@tansy/forms"]) expect(dependencies[name]).toBeDefined();
  });

  it("starts Postgres in Docker without putting its password in a file git keeps", () => {
    const cwd = folder();
    const out = create(cwd, "pg", "--database", "docker", "--host", "serverless", "--storage", "vercel-blob");
    const compose = read(cwd, "pg/docker-compose.yml");
    expect(compose).toContain("${POSTGRES_PASSWORD:?");
    expect(compose).toContain("127.0.0.1:5432:5432");
    expect(out).toContain("docker compose up -d --wait");
    expect(JSON.parse(read(cwd, "pg/vercel.json")).crons[0].path).toBe("/api/background");
  });

  it("refuses what can't work on the host chosen", () => {
    const cwd = folder();
    expect(() => create(cwd, "a", "--host", "serverless", "--database-url", "file:./dev.db", "--storage", "s3")).toThrow(/SQLite/);
    expect(() => create(cwd, "b", "--host", "serverless", "--database", "docker", "--storage", "local")).toThrow(/uploads/);
    expect(() => create(cwd, "c", "--database", "postgres")).toThrow(/--database-url/);
    expect(() => create(cwd, "d", "--plugins", "email:carrier-pigeon")).toThrow(/Unknown email provider/);
    expect(problems({ host: "server", database: "sqlite", storage: "local" })).toEqual([]);
  });

  it("asks nothing without a terminal, so a folder is required", () => {
    expect(() => create(folder())).toThrow(/Name a folder/);
  });

  it("gives every theme the plugins it renders, once each", () => {
    expect(pluginsFor({ theme: "dispatch", plugins: [parsePlugin("email")] }).map((plugin) => plugin.name)).toEqual(["blog", "email", "newsletter"]);
    expect(pluginsFor({ theme: "storefront", plugins: [parsePlugin("payments:dodo")] })).toEqual([{ name: "payments", provider: "dodo" }, { name: "shop" }]);
    expect(cmsConfig({ theme: "blog", storage: "local", plugins: [] })).toContain("blogPlugin({ siteUrl })");
    expect(cmsConfig({ theme: "blank", storage: "local", plugins: [] })).not.toContain("siteUrl");
  });

  it("installs with the package manager that ran it", () => {
    expect(packageManager("pnpm/10.0.0 npm/? node/v24.0.0")).toBe("pnpm");
    expect(packageManager("bun/1.3.0")).toBe("bun");
    expect(packageManager("")).toBe("npm");
  });

  it("gives the headless template no database and no secrets", () => {
    const cwd = folder();
    create(cwd, "front", "--template", "headless");
    expect(existsSync(path.join(cwd, "front/tansy.config.ts"))).toBe(false);
    expect(existsSync(path.join(cwd, "front/.env"))).toBe(false);
    expect(read(cwd, "front/app/[[...path]]/page.tsx")).toContain("client.reader(CACHE)");
    expect(read(cwd, "front/app/api/cms-revalidate/route.ts")).toContain("process.env.TANSY_WEBHOOK_SECRET");
    expect(read(cwd, "front/next.config.ts")).toContain("no-referrer");
    // The names the generated code reads.
    expect(read(cwd, "front/.env.example")).toMatch(/^TANSY_URL=/m);
    expect(read(cwd, "front/.env.example")).toMatch(/^TANSY_WEBHOOK_SECRET=/m);
  });

  it("keeps secrets and databases out of git", () => {
    const cwd = folder();
    create(cwd, "site");
    for (const line of [".env*", "*.db"]) expect(read(cwd, "site/.gitignore").split("\n")).toContain(line);
  });

  it("refuses a folder in use, an unknown template and a bad name", () => {
    const cwd = folder();
    mkdirSync(path.join(cwd, "taken"));
    writeFileSync(path.join(cwd, "taken/file"), "");
    expect(() => create(cwd, "taken")).toThrow(/isn't empty/);
    expect(() => create(cwd, "ok", "--template", "nope")).toThrow(/Unknown template/);
    expect(() => create(cwd, "Bad Name")).toThrow(/package name/);
  });
});

describe("tansy doctor", () => {
  const secure = { DATABASE_URL: "file:./x.db", BETTER_AUTH_SECRET: "s".repeat(32), TANSY_ENCRYPTION_KEY: "k".repeat(32), BETTER_AUTH_URL: "https://example.com" } as unknown as NodeJS.ProcessEnv;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
  });
  afterEach(() => vi.restoreAllMocks());

  function host(config: string) {
    const cwd = folder();
    writeFileSync(path.join(cwd, "package.json"), "{}");
    writeFileSync(path.join(cwd, "tansy.config.ts"), config);
    return cwd;
  }

  const output = () => lines.join("\n");

  it("reports maps that don't match the config", async () => {
    await doctor({ cwd: host("export default { plugins: [] };"), env: secure });
    expect(output()).toMatch(/FAIL {2}the plugin maps match tansy\.config\.ts\n\s+Out of date: \.tansy\/admin\.ts/);
  });

  it("reports a config that can't load, instead of crashing", async () => {
    await doctor({ cwd: host('throw new Error("boom");'), env: secure });
    expect(output()).toMatch(/FAIL {2}tansy\.config\.ts loads\n\s+.*boom/);
  });

  it("warns about unsafe settings without failing on them", async () => {
    await doctor({ cwd: host("export default {};"), env: { ...secure, BETTER_AUTH_URL: "http://example.com", TANSY_WEBHOOK_ALLOW_PRIVATE: "true", ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true", TANSY_ENCRYPTION_KEY: secure.BETTER_AUTH_SECRET } });
    for (const label of ["the public address uses HTTPS", "webhooks can't reach private addresses", "uploads use a real storage service", "the auth secret and encryption key differ"]) expect(output()).toContain(`WARN  ${label}`);
  });

  it("doesn't warn when the address is local or https", async () => {
    await doctor({ cwd: host("export default {};"), env: { ...secure, BETTER_AUTH_URL: "http://localhost:3000" } });
    expect(output()).toContain("ok    the public address uses HTTPS");
  });

  it("warns when .env is readable by others or not ignored", async () => {
    const cwd = host("export default {};");
    writeFileSync(path.join(cwd, ".env"), "", { mode: 0o644 });
    await doctor({ cwd, env: secure });
    expect(output()).toContain("WARN  .env is private to its owner");
    expect(output()).toContain("WARN  .env is ignored by git");
  });

  it("lists what each plugin exposes", async () => {
    await doctor({ cwd: host(`export default { plugins: [{ name: "acme", version: "1.0.0", permissions: { "ext.acme": ["read"] }, csp: { img: ["https://a.test"] }, routes: [{ method: "GET", path: "/open", access: "public", reason: "It has to be." }] }] };`), env: secure });
    expect(output()).toContain("acme 1.0.0");
    expect(output()).toContain("adds permissions: ext.acme:read");
    expect(output()).toContain("GET    /api/ext/acme/open  (public: It has to be.)");
    expect(output()).toContain("allows outside origins: img https://a.test");
  });

  it("runs a plugin's own checks, labelled with its name", async () => {
    const config = `export default { plugins: [{ name: "acme", version: "1.0.0", doctor: () => [
      { ok: false, label: "its key is set", fix: "Set ACME_KEY." },
      { ok: false, label: "it talks to the live service", warning: true, fix: "ACME_TEST is on." },
      { ok: true, label: "its address is https" },
    ] }] };`;
    await doctor({ cwd: host(config), env: secure });
    expect(output()).toContain("FAIL  acme: its key is set\n        Set ACME_KEY.");
    expect(output()).toContain("WARN  acme: it talks to the live service");
    expect(output()).toContain("ok    acme: its address is https");
  });

  it("reports a plugin whose checks throw, and still runs the rest", async () => {
    const config = `export default { plugins: [
      { name: "bad", version: "1.0.0", doctor: () => { throw new Error("no good"); } },
      { name: "fine", version: "1.0.0", doctor: () => [{ ok: true, label: "it is fine" }] },
    ] };`;
    await doctor({ cwd: host(config), env: secure });
    expect(output()).toContain("FAIL  bad's own checks ran");
    expect(output()).toContain("no good");
    expect(output()).toContain("ok    fine: it is fine");
  });

  it("fails when two plugins each split records by scope", async () => {
    const config = `export default { plugins: [
      { name: "multi-tenant", version: "1.0.0", scope: { label: "Tenant" } },
      { name: "workspaces", version: "1.0.0", scope: { label: "Workspace" } },
    ] };`;
    await doctor({ cwd: host(config), env: secure });
    expect(output()).toContain("FAIL  one plugin splits records by scope");
    expect(output()).toContain("multi-tenant and workspaces");
  });
});

describe("package directory", () => {
  const item = (name: string, extra = {}) => ({ package: { name, version: "1.0.0", description: "d", ...extra } });
  const npm = (objects: unknown[]) => vi.fn(async () => Response.json({ objects })) as unknown as typeof fetch;

  beforeEach(() => clearDirectoryCache());

  it("asks npm by keyword, at a fixed address, without following redirects", async () => {
    const fetcher = npm([]);
    await loadDirectory(fetcher);
    const calls = (fetcher as unknown as { mock: { calls: Array<[URL, RequestInit]> } }).mock.calls;
    expect(calls.map(([url]) => url.searchParams.get("text")).sort()).toEqual(["keywords:tansy-plugin", "keywords:tansy-theme"]);
    for (const [url, init] of calls) {
      expect(url.origin).toBe("https://registry.npmjs.org");
      expect(init.redirect).toBe("error");
    }
  });

  it("lists by name, so the order isn't a ranking", async () => {
    const directory = await loadDirectory(npm([item("zeta"), item("alpha")]));
    expect(directory?.plugins.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("links only to npm, whatever an author supplies, and drops names that aren't package names", async () => {
    const directory = await loadDirectory(npm([item("good", { links: { homepage: "javascript:alert(1)" } }), item("javascript:alert(1)"), item("../evil")]));
    expect(directory?.plugins).toEqual([{ name: "good", version: "1.0.0", description: "d", url: "https://www.npmjs.com/package/good" }]);
  });

  it("shortens a long description", async () => {
    const directory = await loadDirectory(npm([item("long", { description: "x".repeat(5000) })]));
    expect(directory?.plugins[0].description).toHaveLength(300);
  });

  it("shows nothing when npm fails or answers strangely, and tries again next time", async () => {
    expect(await loadDirectory(vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(await loadDirectory(vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).toBeNull();
    expect(await loadDirectory(vi.fn(async () => Response.json({ nope: true })) as unknown as typeof fetch)).toBeNull();
    expect(await loadDirectory(npm([item("back")]))).not.toBeNull();
  });

  it("asks npm at most once an hour", async () => {
    const fetcher = npm([item("a")]);
    await loadDirectory(fetcher, 0);
    await loadDirectory(fetcher, 59 * 60 * 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await loadDirectory(fetcher, 61 * 60 * 1000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
