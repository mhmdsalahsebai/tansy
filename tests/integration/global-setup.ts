import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { APP_DIR, CLI } from "./app-under-test";
import { DNS_PORT, startDns } from "./dns-server";
import { blankStarterEnv } from "./server-env";

// TEST_PORT moves the app off 3457 when something else holds it.
const PORT = Number(process.env.TEST_PORT ?? 3457);
const SMTP_PORT = 2587;
const CAPTCHA_PORT = 2589;
// Row scopes: the workspaces example by default. TEST_SCOPES=off runs the suite without a provider,
// as an instance without one is, and TEST_SCOPES=multi-tenant with the multi-tenant plugin instead.
const SCOPE_MODE = process.env.TEST_SCOPES === "off" ? "off" : process.env.TEST_SCOPES === "multi-tenant" ? "multi-tenant" : "workspaces";
const SCOPES = SCOPE_MODE === "workspaces";
const TENANTS = SCOPE_MODE === "multi-tenant";

/** Stands in for the CAPTCHA provider. The response field decides the answer. */
function startCaptchaVerifier() {
  return http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: body.includes("good-token") }));
    });
  }).listen(CAPTCHA_PORT, "127.0.0.1");
}

/** Minimal SMTP sink so email flows are tested through the real mail path. */
function startSmtp() {
  const mailbox: string[] = [];
  const server = net.createServer((socket) => {
    socket.write("220 sink\r\n");
    let inData = false;
    let data = "";
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (inData) {
          if (line === ".") { inData = false; mailbox.push(data); data = ""; socket.write("250 ok\r\n"); } else data += line + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "DATA") { inData = true; socket.write("354 go\r\n"); } else if (cmd === "QUIT") socket.end("221 bye\r\n"); else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  server.listen(SMTP_PORT, "127.0.0.1");
  return { server, mailbox };
}

/** TypeScript on purpose: the server has to load it directly, with no build step. */
const HOOK_FILE = `
interface Before { collection: { slug: string }; values: Record<string, unknown>; reject(message: string, field?: string): never }
export default (cms: any) => {
  cms.on("record.beforeCreate", (ctx: Before) => {
    if (ctx.collection.slug !== "hooked") return;
    if (ctx.values.title === "forbidden") ctx.reject("Not that title.", "title");
    if (ctx.values.title === "too-long") return { ...ctx.values, title: "x".repeat(50) };
    ctx.values.title = String(ctx.values.title).toUpperCase();
  });
  cms.on("record.afterCreate", async (ctx: any) => {
    if (ctx.collection.slug === "hooked") await ctx.system.records.create("hook-log", { title: "saw " + ctx.record.id });
  });
  cms.on("record.afterUpdate", async (ctx: any) => {
    if (ctx.collection.slug === "hooked") await ctx.system.records.create("hook-log", { title: "upd " + ctx.previous?.title + ">" + ctx.record.title });
  });
  cms.on("record.afterCreate", async (ctx: any) => {
    if (ctx.collection.slug !== "hooked" || ctx.record.title !== "FLAKY") return;
    const key = "flaky:" + ctx.record.id;
    const tries = Number((await ctx.store.get(key)) ?? 0) + 1;
    await ctx.store.set(key, tries);
    if (tries < 2) throw new Error("not yet");
    await ctx.system.records.create("hook-log", { title: "flaky ok " + ctx.record.id });
  });
  cms.route({ method: "POST", path: "/claim/:key", access: "authenticated", audit: "hook.claim", handler: async (ctx: any) => ({ won: await ctx.store.claim(ctx.params.key, true) }) });
  cms.route({ method: "POST", path: "/cas/:id/:from/:to", access: "authenticated", audit: "hook.cas", handler: async (ctx: any) => ({ matched: (await ctx.system.records.update("hooked", Number(ctx.params.id), { title: ctx.params.to }, { if: { title: ctx.params.from } })) !== null }) });
  cms.route({ method: "POST", path: "/cas-field/:id/:field", access: "authenticated", audit: "hook.cas", handler: async (ctx: any) => ctx.records.update("hooked", Number(ctx.params.id), { title: "x" }, { if: { [ctx.params.field]: "x" } }) });
  cms.on("record.beforeDelete", (ctx: any) => { if (ctx.collection.slug === "hooked" && ctx.record.title === "KEEP") ctx.reject("This one stays."); });
  cms.route({ method: "GET", path: "/whoami", access: "authenticated", handler: (ctx: any) => ({ id: ctx.principal.user.id }) });
  cms.route({ method: "GET", path: "/staff", access: "permission", permission: "user:list", handler: () => ({ ok: true }) });
  cms.route({ method: "POST", path: "/echo/:name", access: "authenticated", audit: "hook.echo", handler: (ctx: any) => ({ name: ctx.params.name }) });
  cms.route({ method: "GET", path: "/version", access: "public", reason: "test", handler: () => ({ version: 1 }) });
  cms.on("schema.afterCreate", async (ctx: any) => { await ctx.store.set("last-collection", ctx.data.collection.slug); });
  cms.route({ method: "GET", path: "/last-collection", access: "public", reason: "test", handler: async (ctx: any) => ({ slug: await ctx.store.get("last-collection") }) });
  cms.job({ name: "test.tick", cron: "* * * * *", handler: () => {} });
};
`;

/** These wipe everything, so they refuse anything not obviously a test database. */
function resetSqlite(url: string) {
  const file = url.slice("file:".length);
  if (!/test|smoke/i.test(path.basename(file))) throw new Error('TEST_DATABASE_URL file name must contain "test" or "smoke".');
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(file + suffix, { force: true });
  // TEST_DATABASE_URL may name a folder of its own, such as file:./.data/cms_test.db.
  mkdirSync(path.dirname(file), { recursive: true });
}

async function resetPostgres(url: string) {
  if (!/test|smoke/i.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL database name must contain "test" or "smoke".');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();
}

export default async function setup(project: TestProject) {
  // Absolute, because the server, Prisma and these tests each run from a different folder.
  const given = process.env.TEST_DATABASE_URL ?? "";
  const url = given.startsWith("file:") ? `file:${path.resolve(given.slice("file:".length))}` : given;
  if (/^postgres(ql)?:/i.test(url)) await resetPostgres(url);
  else if (url.startsWith("file:")) resetSqlite(url);
  else throw new Error("Set TEST_DATABASE_URL to a disposable SQLite file, such as file:./.data/cms_test.db, or a disposable Postgres database.");

  const uploads = mkdtempSync(path.join(tmpdir(), "cms-test-uploads-"));
  const hooksDir = mkdtempSync(path.join(tmpdir(), "cms-test-hooks-"));
  writeFileSync(path.join(hooksDir, "main.ts"), HOOK_FILE);
  const env = {
    ...process.env,
    // Deaf to apps/starter/.env: every switch the starter config reads starts off, and this object
    // turns on what the suite wants. See tests/integration/server-env.ts.
    ...blankStarterEnv(),
    S3_BUCKET: "",
    UPLOADS_DIR: uploads,
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true",
    MAX_UPLOAD_BYTES: String(12 * 1024 * 1024),
    SCHEDULE_TICK_MS: "500",
    JOB_TICK_MS: "500",
    MAINTENANCE_TICK_MS: "500",
    CRON_SECRET: "integration-cron-secret",
    TANSY_BACKGROUND: "timers",
    WEBHOOK_TICK_MS: "200",
    HOOK_TICK_MS: "200",
    TANSY_WEBHOOK_ALLOW_PRIVATE: "true",
    TANSY_HOOKS_DIR: hooksDir,
    TANSY_EXAMPLE_SEO: "true",
    TANSY_PLUGIN_CAPTCHA: "true",
    TURNSTILE_SITE_KEY: "public-site-key",
    TURNSTILE_SECRET_KEY: "captcha-secret-value",
    // No sign-in form asks at first, so the rest of the suite signs in without a CAPTCHA.
    TANSY_CAPTCHA_FORMS: "",
    TANSY_CAPTCHA_VERIFY_URL: `http://127.0.0.1:${CAPTCHA_PORT}/`,
    TANSY_EXAMPLE_DENIED_PASSWORDS: "forbiddenword",
    TANSY_EXAMPLE_SIGN_IN_ALERTS: "true",
    TANSY_EXAMPLE_EMAIL_TEMPLATES: "true",
    // Row scopes: two workspaces, each with one editor. Collections stay shared unless a test scopes one.
    TANSY_EXAMPLE_WORKSPACES: SCOPES ? "alpha:wsann@example.test;beta:wsbob@example.test" : "",
    // Tenants, with new collections left shared so the other suites run as they do without it.
    TANSY_PLUGIN_MULTI_TENANT: TENANTS ? "true" : "false",
    TANSY_MULTI_TENANT_SCOPE_NEW: "false",
    // Tenants' domains are verified against the stand-in DNS server.
    TANSY_MULTI_TENANT_DNS_SERVERS: `127.0.0.1:${DNS_PORT}`,
    TANSY_EXAMPLE_IP_ALLOWLIST: "0.0.0.0/1,::1",
    // Off whatever apps/starter/.env says: it would add plans and collections of its own.
    TANSY_EXAMPLE_PLAN_ACCESS: "false",
    TANSY_EXAMPLE_SEO_COLLECTIONS: "seo-posts",
    TANSY_PLUGIN_BLOG: "true",
    // Two themes installed, blank being the default, so a tenant can be served in the other.
    // Baked into the build, so tests/integration/build.mjs sets the same list.
    TANSY_THEMES: "blank,blog",
    TANSY_PLUGIN_LMS: "true",
    TANSY_PLUGIN_EMAIL: "true",
    TANSY_PLUGIN_PAYMENTS: "true",
    TANSY_PLUGIN_SHOP: "true",
    TANSY_PLUGIN_SUBSCRIPTIONS: "true",
    TANSY_PLUGIN_AI: "true",
    TANSY_PLUGIN_FORMS: "true",
    TANSY_PLUGIN_NEWSLETTER: "true",
    TANSY_PLUGIN_ANALYTICS: "true",
    TANSY_PLUGIN_REQUEST_LOGS: "true",
    TANSY_BLOG_NOTIFY: "blog-moderator@example.test",
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: "integration-secret-integration-secret",
    TANSY_ENCRYPTION_KEY: "integration-encryption-key-integration",
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
  };
  execFileSync(process.execPath, [CLI, "migrate"], { cwd: APP_DIR, env, stdio: "pipe" });

  const smtp = startSmtp();
  const captchaVerifier = startCaptchaVerifier();
  const dns = startDns();
  const server: ChildProcess = spawn("npx", ["next", "start", "-p", String(PORT)], { env, cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true });

  let log = "";
  const setupToken = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No setup link in server output:\n${log}`)), 90_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const match = /setup\?token=([\w-]+)/.exec(log);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    server.stdout!.on("data", onData);
    server.stderr!.on("data", onData);
  });
  await waitFor(`http://localhost:${PORT}/api/auth-config`);

  project.provide("baseUrl", `http://localhost:${PORT}`);
  project.provide("setupToken", setupToken);
  project.provide("databaseUrl", url);
  project.provide("smtpPort", SMTP_PORT);
  project.provide("hooksDir", hooksDir);
  project.provide("scopes", SCOPES);
  project.provide("tenants", TENANTS);
  // Vitest runs tests in workers; expose the mailbox over a tiny local socket.
  const mailboxServer = net.createServer((socket) => socket.end(JSON.stringify(smtp.mailbox)));
  mailboxServer.listen(2588, "127.0.0.1");

  return async () => {
    mailboxServer.close();
    smtp.server.close();
    captchaVerifier.close();
    dns.close();
    try { process.kill(-server.pid!, "SIGTERM"); } catch { /* already gone */ }
    rmSync(uploads, { recursive: true, force: true });
    rmSync(hooksDir, { recursive: true, force: true });
    if (/\[api\] |TypeError|ReferenceError/.test(log)) console.warn("Server log contained errors:\n" + log.slice(-6000));
  };
}

async function waitFor(url: string) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

declare module "vitest" {
  export interface ProvidedContext { baseUrl: string; setupToken: string; databaseUrl: string; smtpPort: number; hooksDir: string; scopes: boolean; tenants: boolean }
}
