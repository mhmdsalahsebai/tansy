/**
 * Phase 9's exit test. Packs the tarball, installs it into a fresh create-next-app with
 * npm, and runs the integration suite against that install. From the tarball on purpose:
 * linked workspace packages behave differently from published ones. Then Phase 14's:
 * create-tansy's templates, and a plugin and theme written with the generators.
 *
 * TEST_DATABASE_URL names a disposable database, as for test:integration.
 * KEEP_APP=1 leaves the app on disk for debugging.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STARTER = path.join(ROOT, "apps/starter");
const NEXT_VERSION = JSON.parse(readFileSync(path.join(ROOT, "node_modules/next/package.json"), "utf8")).version;
const PORT = 3471;
const HEADLESS_PORT = 3472;

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a disposable database.");

// Not the system temp folder: it's often a small RAM disk, and this holds a full node_modules and build.
const parent = path.join(homedir(), ".cache/tansy-package-test");
mkdirSync(parent, { recursive: true });
const work = mkdtempSync(path.join(parent, "run-"));
const app = path.join(work, "host");
const tarballs = path.join(work, "tarballs");
mkdirSync(tarballs);

// Nothing from the repository's environment should reach the install.
const { TEST_DATABASE_URL, DATABASE_URL: _d, BETTER_AUTH_SECRET: _s, BETTER_AUTH_URL: _u, ...clean } = process.env;
const appEnv = { ...clean, NEXT_TELEMETRY_DISABLED: "1" };
const run = (command, args, options = {}) => {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", env: appEnv, ...options });
};
const inApp = { cwd: app };
const cms = (...args) => run(path.join(app, "node_modules/.bin/tansy"), args, inApp);

function packTarballs() {
  const { dependencies } = JSON.parse(readFileSync(path.join(STARTER, "package.json"), "utf8"));
  const workspace = Object.keys(dependencies).filter((dep) => dep.startsWith("@tansy/"));
  // Published packages go through the real builder, so what is installed here is what npm would serve:
  // compiled files, compiled `exports`, and a manifest with no workspace-only keys left in it.
  const builtHere = workspace.filter((name) => !name.startsWith("@tansy/example-"));
  run(process.execPath, ["scripts/build-packages.mjs", "tansy", ...builtHere], { cwd: ROOT });
  // The examples are never published, so they are packed from their folders, as a community
  // package that ships TypeScript would be.
  for (const name of workspace.filter((dep) => dep.startsWith("@tansy/example-"))) {
    run("npm", ["pack", "-w", name, "--pack-destination", path.join(ROOT, ".release"), "--silent"], { cwd: ROOT });
  }
  const built = readdirSync(path.join(ROOT, ".release")).filter((name) => name.endsWith(".tgz"));
  for (const name of built) cpSync(path.join(ROOT, ".release", name), path.join(tarballs, name));
  const { version } = JSON.parse(readFileSync(path.join(ROOT, "packages/cms/package.json"), "utf8"));
  const cms = `tansy-${version}.tgz`;
  if (!built.includes(cms)) throw new Error(`The builder didn't write ${cms}.`);
  return { cms: [path.join(tarballs, cms)], all: readdirSync(tarballs).map((name) => path.join(tarballs, name)) };
}

async function withServer(env, check, { cwd = app, port = PORT, ready: readyPath = "/api/auth-config" } = {}) {
  const server = spawn("npx", ["next", "start", "-p", String(port)], { cwd, env: { ...appEnv, ...env }, stdio: "inherit", detached: true });
  try {
    for (let i = 0; ; i++) {
      const ready = await fetch(`http://localhost:${port}${readyPath}`).then((r) => r.status < 500).catch(() => false);
      if (ready) break;
      if (i > 120) throw new Error("The plain host app did not start.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await check();
  } finally {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

function assertStatus(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

/** The app exactly as `tansy init` leaves it, so a broken template can't hide behind the suite's config. */
async function checkPlainInit() {
  cms("init");
  for (const required of ["app/(site)/layout.tsx", "app/(site)/page.tsx", "tansy.config.ts", "proxy.ts", ".env"]) {
    if (!existsSync(path.join(app, required))) throw new Error(`tansy init didn't produce ${required}`);
  }
  if (!readFileSync(path.join(app, "next.config.ts"), "utf8").includes("withCms(nextConfig)")) throw new Error("tansy init didn't wrap next.config.ts");
  const env = { DATABASE_URL: `file:${path.join(work, "plain_smoke.db")}` };
  run(path.join(app, "node_modules/.bin/tansy"), ["doctor"], { ...inApp, env: { ...appEnv, ...env } });
  run(path.join(app, "node_modules/.bin/tansy"), ["migrate"], { ...inApp, env: { ...appEnv, ...env } });
  run("npx", ["next", "build"], { ...inApp, env: { ...appEnv, ...env } });
  await withServer({ ...env, BETTER_AUTH_URL: `http://localhost:${PORT}`, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true" }, async () => {
    const at = (url) => fetch(`http://localhost:${PORT}${url}`, { redirect: "manual" });
    const home = await at("/");
    assertStatus(home.status, 200, "the host's own home page");
    const nonce = /'nonce-([^']+)'/.exec(home.headers.get("content-security-policy") ?? "")?.[1];
    if (!nonce || !(await home.text()).includes(`nonce="${nonce}"`)) throw new Error("The host's home page has no per-request nonce, so its scripts would be blocked.");
    assertStatus((await at("/dashboard/auth/signin")).status, 200, "the sign-in page");
    assertStatus((await at("/dashboard")).status, 307, "the dashboard, signed out");
  });
  // Backups from the published package: the CLI loads compiled core, and encrypts with the key tansy init wrote.
  const backups = path.join(work, "backups");
  mkdirSync(backups);
  const withDatabase = { ...inApp, env: { ...appEnv, ...env } };
  run(path.join(app, "node_modules/.bin/tansy"), ["backup", "--out", backups], withDatabase);
  const [archive] = readdirSync(backups);
  if (!archive?.endsWith(".tar.gz.enc")) throw new Error(`tansy backup wrote ${archive ?? "nothing"}, not an encrypted archive.`);
  run(path.join(app, "node_modules/.bin/tansy"), ["backup", "verify", path.join(backups, archive)], withDatabase);
  run(path.join(app, "node_modules/.bin/tansy"), ["restore", path.join(backups, archive), "--yes", "--safety-dir", backups], withDatabase);
  if (!readdirSync(backups).some((name) => name.startsWith("cms-before-restore-"))) throw new Error("tansy restore didn't save the database it replaced.");
}

/** Adds to the plain app what the suite needs: its plugins, and a host route, page and proxy. */
function addSuiteFixtures() {
  cms("init", "--site");
  cpSync(path.join(STARTER, "tansy.config.ts"), path.join(app, "tansy.config.ts"));
  const { dependencies } = JSON.parse(readFileSync(path.join(STARTER, "package.json"), "utf8"));
  const plugins = Object.keys(dependencies).filter((dep) => dep.startsWith("@tansy/"));
  writeFileSync(path.join(app, "next.config.ts"), `import { withCms } from "tansy/next";\n\nexport default withCms({ transpilePackages: ${JSON.stringify(plugins)} });\n`);
  writeFileSync(path.join(app, "proxy.ts"), `import { NextResponse, type NextRequest } from "next/server";
import { createCmsProxy } from "tansy/proxy";
import cspAdditions from "./.tansy/csp";

export const proxy = createCmsProxy(cspAdditions, {
  proxy: (request: NextRequest) => (request.nextUrl.search.includes("host-redirect") || request.nextUrl.pathname === "/host-redirect" ? NextResponse.redirect(new URL("/", request.url)) : undefined),
});

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/files/upload$).*)"] };
`);
  mkdirSync(path.join(app, "app/api/hello"), { recursive: true });
  writeFileSync(path.join(app, "app/api/hello/route.ts"), `export const GET = () => Response.json({ hello: "host" });\n`);
  const layout = path.join(app, "app/(site)/layout.tsx");
  writeFileSync(layout, readFileSync(layout, "utf8").replace("<body", '<body data-host-site="yes"'));
}

const CREATE = path.join(ROOT, "packages/create-tansy/index.mjs");
const SERVED = { ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true" };

function createApp(name, template) {
  const target = path.join(work, name);
  run(process.execPath, [CREATE, target, "--template", template, "--packages", tarballs], { cwd: work });
  return target;
}

/**
 * Phase 14's exit test, by the steps in docs/guides: a package generated in a new app,
 * tested, packed the way npm publish would, then installed from that file alone.
 */
async function checkAuthoring() {
  const site = createApp("authored", "blank");
  const tool = path.join(site, "node_modules/.bin/tansy");
  const inSite = { cwd: site };
  run(tool, ["plugin", "new", "demo", "--package", "cms-plugin-demo"], inSite);
  run(tool, ["field", "new", "rating", "--plugin", "plugins/demo"], inSite);
  run(tool, ["theme", "new", "demo-look", "--package", "cms-theme-demo-look"], inSite);
  run("npm", ["test"], { cwd: path.join(site, "plugins/demo") });

  const published = path.join(work, "published");
  mkdirSync(published);
  for (const folder of ["plugins/demo", "themes/demo-look"]) run("npm", ["pack", "--pack-destination", published, "--silent"], { cwd: path.join(site, folder) });
  rmSync(path.join(site, "plugins"), { recursive: true });
  rmSync(path.join(site, "themes"), { recursive: true });
  run("npm", ["install", "--no-audit", "--no-fund", ...readdirSync(published).map((name) => path.join(published, name))], inSite);

  const config = path.join(site, "tansy.config.ts");
  const before = readFileSync(config, "utf8");
  const after = before
    .replace('import { blank } from "@tansy/theme-blank";', 'import { demoPlugin } from "cms-plugin-demo";\nimport { demoLookTheme } from "cms-theme-demo-look";')
    .replace("theme: blank()", "theme: demoLookTheme()")
    .replace("plugins: []", "plugins: [demoPlugin()]");
  if (after === before) throw new Error("The generated tansy.config.ts no longer has the lines this test edits.");
  writeFileSync(config, after);
  run(tool, ["sync"], inSite);
  run(tool, ["doctor"], inSite);
  run("npx", ["next", "build"], inSite);

  const adminCode = readdirSync(path.join(site, ".next/static"), { recursive: true }).filter((file) => String(file).endsWith(".js")).some((file) => readFileSync(path.join(site, ".next/static", String(file)), "utf8").includes("demo_rating"));
  if (!adminCode) throw new Error("The plugin's field input didn't reach the admin's browser code.");
  await withServer({ ...SERVED, BETTER_AUTH_URL: `http://localhost:${PORT}` }, async () => {
    const home = await fetch(`http://localhost:${PORT}/`);
    assertStatus(home.status, 200, "a site using the generated theme");
    if (!(await home.text()).includes("theme-shell")) throw new Error("The generated theme's layout didn't render.");
  }, { cwd: site });
  // Startup creates a plugin's blocks, so this shows the server really ran the installed package.
  const check = `const D = require("better-sqlite3"); const rows = new D("dev.db").prepare('SELECT name FROM "BlockType" WHERE name = ?').all("demo_note_card"); if (rows.length !== 1) process.exit(1);`;
  run(process.execPath, ["-e", check], inSite);
}

/** Both other templates, with the headless one reading the same-app one over HTTP. */
async function checkTemplates() {
  const blog = createApp("blog-site", "blog");
  run("npx", ["next", "build"], { cwd: blog });
  const headless = createApp("front-end", "headless");
  run("npx", ["next", "build"], { cwd: headless });
  await withServer({ ...SERVED, BETTER_AUTH_URL: `http://localhost:${PORT}` }, async () => {
    assertStatus((await fetch(`http://localhost:${PORT}/`)).status, 200, "the blog template's home page");
    await withServer({ TANSY_URL: `http://localhost:${PORT}` }, async () => {
      // This server has no home record and the blank theme has no home template, so 404 is the right answer. A failed read would be a 500.
      assertStatus((await fetch(`http://localhost:${HEADLESS_PORT}/`)).status, 404, "the headless template, reading a real server");
    }, { cwd: headless, port: HEADLESS_PORT, ready: "/" });
  }, { cwd: blog });
}

let failed = true;
try {
  const packed = packTarballs();
  run("npx", ["--yes", `create-next-app@${NEXT_VERSION}`, app, "--ts", "--eslint", "--app", "--no-src-dir", "--no-tailwind", "--no-react-compiler", "--import-alias", "@/*", "--use-npm", "--disable-git", "--yes"], { cwd: work });
  run("npm", ["install", "--no-audit", "--no-fund", ...packed.cms], inApp);
  await checkPlainInit();
  run("npm", ["install", "--no-audit", "--no-fund", ...packed.all], inApp);
  addSuiteFixtures();
  run("npx", ["next", "build"], { ...inApp, env: { ...appEnv, DATABASE_URL: "file:/tmp/build.db" } });
  run("npx", ["vitest", "run", "-c", "vitest.integration.config.ts"], { cwd: ROOT, env: { ...process.env, TEST_DATABASE_URL, TANSY_TEST_APP: app } });
  await checkAuthoring();
  await checkTemplates();
  failed = false;
} finally {
  if (process.env.KEEP_APP) console.log(`Kept ${app}`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
