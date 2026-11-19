import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3458;

/** Starts the production build on a throwaway SQLite file and hands the first-run token to the tests. */
export default async function globalSetup() {
  const dir = mkdtempSync(path.join(tmpdir(), "cms-e2e-"));
  const env = {
    ...process.env,
    DATABASE_URL: `file:${path.join(dir, "cms_e2e_test.db")}`,
    UPLOADS_DIR: path.join(dir, "uploads"),
    S3_BUCKET: "",
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true",
    TANSY_HOOKS_DIR: path.join(dir, "hooks"),
    BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
    TANSY_ENCRYPTION_KEY: "e2e-encryption-key-e2e-encryption-key",
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    NEXT_PUBLIC_TANSY_PREVIEW_URL: "http://localhost:3459",
    TANSY_PLUGIN_CAPTCHA: "true",
    TURNSTILE_SITE_KEY: "public-site-key",
    TURNSTILE_SECRET_KEY: "captcha-secret-value",
    TANSY_CAPTCHA_FORMS: "forgot-password",
    TANSY_CAPTCHA_VERIFY_URL: "http://127.0.0.1:3460/",
  };
  execFileSync("npx", ["prisma", "migrate", "deploy", "--config", "packages/cms/prisma.config.ts"], { env, stdio: "pipe" });
  const verifier = http.createServer((_, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ success: true })); }).listen(3460, "127.0.0.1");
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, cwd: "apps/starter", stdio: ["ignore", "pipe", "pipe"], detached: true });

  let log = "";
  process.env.E2E_SETUP_TOKEN = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No setup link in server output:\n${log}`)), 90_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const match = /setup\?token=([\w-]+)/.exec(log);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
  });

  return async () => {
    try { process.kill(-server.pid!, "SIGTERM"); } catch { /* already gone */ }
    verifier.close();
    rmSync(dir, { recursive: true, force: true });
  };
}
