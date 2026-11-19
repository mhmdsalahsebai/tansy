/** Read-only checks of a host app. Exits non-zero when something needs fixing. Warnings don't. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { hasCmsConfig, loadCmsConfig, staleMaps } from "./sync.mjs";

const PACKAGE = path.resolve(import.meta.dirname, "..");
const MIN_SECRET = 32;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Enough of semver for the "^x.y.z" ranges this package declares. */
function satisfiesCaret(version, range) {
  const parse = (value) => value.replace(/^[^\d]*/, "").split(/[.-]/).slice(0, 3).map(Number);
  const [major, minor, patch] = parse(version);
  const [wantMajor, wantMinor, wantPatch] = parse(range);
  return major === wantMajor && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch));
}

function installedVersion(cwd, name) {
  try {
    return createRequire(path.join(cwd, "package.json"))(`${name}/package.json`).version;
  } catch {
    return null;
  }
}

const read = (cwd, file) => (existsSync(path.join(cwd, file)) ? readFileSync(path.join(cwd, file), "utf8") : null);

/** What each plugin exposes, for reviewing one before trusting it. */
export function printPlugins(config, api, log = console.log) {
  const access = (route) => (route.access === "permission" ? `permission ${route.permission}` : route.access === "public" ? `public: ${route.reason}` : route.access);
  for (const plugin of config.plugins ?? []) {
    log(`${plugin.name} ${plugin.version}`);
    const permissions = Object.entries(plugin.permissions ?? {}).flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`));
    if (permissions.length) log(`  adds permissions: ${permissions.join(", ")}`);
    for (const route of plugin.routes ?? []) {
      log(`  ${route.method.padEnd(6)} ${api}/ext/${plugin.name}${route.path}  (${access(route)})${route.root ? `  also at ${route.path}` : ""}`);
    }
    if (!plugin.routes?.length) log("  no routes");
    const origins = Object.entries(plugin.csp ?? {}).flatMap(([kind, sources]) => sources.map((source) => `${kind} ${source}`));
    if (origins.length) log(`  allows outside origins: ${origins.join(", ")}`);
  }
}

/** The backup settings core checks at startup, plus what it can't: tools on this machine, and where archives go. */
function backups({ config, env, check, warn }) {
  const settings = config?.backups;
  warn(settings, "backups are configured", "Nothing backs up the database or uploads. Set backups in tansy.config.ts. See docs/guides/backups.md.");
  if (!settings) return;
  warn(settings.schedule, "backups run on a schedule", "backups has no schedule, so archives are made only when someone runs tansy backup.");
  if (settings.encrypt !== false) check((env.TANSY_BACKUP_KEY ?? "").length >= MIN_SECRET, "TANSY_BACKUP_KEY is set", `Backups are encrypted with it. Use at least ${MIN_SECRET} random characters, such as openssl rand -base64 32, and keep a copy away from the backups.`);
  else warn(false, "backups are encrypted", "backups.encrypt is false, so every archive holds password hashes and live sessions in the clear.");
  check(typeof settings.adapter?.list === "function", "the backup storage can list its objects", "Backups need list() on their adapter, to find and prune archives.");
  warn(settings.adapter !== config.storage?.adapter, "backups go somewhere other than uploads", "backups.adapter is the uploads adapter, so losing that storage loses the backups with it.");
  if (/^postgres(ql)?:\/\//i.test(env.DATABASE_URL ?? "")) {
    for (const tool of ["pg_dump", "pg_restore", "psql"]) {
      const found = spawnSync(env.TANSY_PG_BIN ? path.join(env.TANSY_PG_BIN, tool) : tool, ["--version"], { encoding: "utf8" });
      check(found.status === 0, `${tool} is installed${found.status === 0 ? ` (${found.stdout.trim().split(" ").pop()})` : ""}`, "Postgres backups need the PostgreSQL client tools, of at least the server's major version. Set TANSY_PG_BIN to their folder if they aren't on PATH.");
    }
  }
}

/** Settings that work but give something up. Each is fine if it was meant. */
function unsafeSettings({ cwd, env, warn }) {
  warn(env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION !== "true", "uploads use a real storage service in production", "ALLOW_LOCAL_STORAGE_IN_PRODUCTION is on, so uploads stay on this server's disk. Back that folder up.");
  warn(env.TANSY_WEBHOOK_ALLOW_PRIVATE !== "true", "webhooks can't reach private addresses", "TANSY_WEBHOOK_ALLOW_PRIVATE is on, so someone who can manage webhooks can make this server call its own network.");
  let url = null;
  try { url = new URL(env.BETTER_AUTH_URL ?? ""); } catch { /* reported as missing above */ }
  warn(!url || url.protocol === "https:" || LOCAL_HOST.test(url.hostname), "the public address uses HTTPS", `BETTER_AUTH_URL is ${url?.origin}, so session cookies and passwords would cross the network unencrypted.`);
  warn(!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET !== env.TANSY_ENCRYPTION_KEY, "the auth secret and encryption key differ", "BETTER_AUTH_SECRET and TANSY_ENCRYPTION_KEY are the same value, so leaking one leaks both.");
  const envFile = path.join(cwd, ".env");
  if (!existsSync(envFile)) return;
  warn(!(statSync(envFile).mode & 0o077), ".env is private to its owner", "Other accounts on this machine can read .env. Run chmod 600 .env.");
  const ignored = (read(cwd, ".gitignore") ?? "").split(/\r?\n/).some((line) => [".env", ".env*", "*.env", "/.env"].includes(line.trim()));
  warn(ignored, ".env is ignored by git", "Add .env to .gitignore, so its secrets can't be committed.");
}

/**
 * Checks plugins add, so a plugin can report what only it knows, such as a setting of its own that
 * gives something up. `tansy doctor` runs with no server and no database, so a plugin's `doctor` gets
 * the config and the environment and nothing else, and anything it reports is labelled with its
 * name. A plugin that throws is reported rather than stopping the rest of the checks.
 */
async function pluginChecks({ config, env, cwd, check, warn }) {
  for (const plugin of config?.plugins ?? []) {
    if (typeof plugin.doctor !== "function") continue;
    let results;
    try {
      results = (await plugin.doctor({ env, cwd })) ?? [];
    } catch (error) {
      check(false, `${plugin.name}'s own checks ran`, `Its doctor threw: ${error.message}`);
      continue;
    }
    for (const result of results) {
      const label = `${plugin.name}: ${result.label}`;
      if (result.warning) warn(result.ok, label, result.fix);
      else check(result.ok, label, result.fix);
    }
  }
}

/** Only one plugin may split records by a scope value, and core refuses two at startup. Said here first. */
function scopeProviders({ config, check }) {
  const providers = (config?.plugins ?? []).filter((plugin) => plugin.scope).map((plugin) => plugin.name);
  if (providers.length < 2) return;
  check(false, "one plugin splits records by scope", `${providers.join(" and ")} each define scope. Only one can, and startup refuses this. Remove one from tansy.config.ts.`);
}

export async function doctor({ cwd, env = process.env }) {
  const { engines, peerDependencies } = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
  const results = [];
  const check = (ok, label, fix) => results.push({ ok: Boolean(ok), label, fix });
  const warn = (ok, label, note) => results.push({ ok: Boolean(ok), label, fix: note, warning: true });

  const minimum = engines.node.replace(/^[^\d]*/, "").split(".").map(Number);
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(major > minimum[0] || (major === minimum[0] && minor >= minimum[1]), `Node ${process.versions.node}`, `Use Node ${engines.node}, which can run cms_hooks files directly.`);

  for (const [name, range] of Object.entries(peerDependencies)) {
    const version = installedVersion(cwd, name);
    check(version && satisfiesCaret(version, range), `${name} ${version ?? "is missing"}`, `Install ${name}@${range}.`);
  }

  const src = existsSync(path.join(cwd, "src/app")) ? "src/" : "";
  const nextConfig = ["next.config.ts", "next.config.mjs", "next.config.js"].map((file) => read(cwd, file)).find(Boolean);
  check(nextConfig?.includes("withCms"), "next.config wraps withCms", "Run tansy init, or wrap the config in withCms().");
  check(read(cwd, `${src}proxy.ts`)?.includes("createCmsProxy"), "proxy uses createCmsProxy", "Without it the admin has no security headers. Run tansy init.");
  check(read(cwd, `${src}instrumentation.ts`)?.includes("startCms"), "instrumentation calls startCms", "Without it the CMS doesn't start. Run tansy init.");
  check(hasCmsConfig(cwd), "tansy.config.ts exists", "Run tansy init.");
  check(existsSync(path.join(cwd, ".tansy/admin.ts")), "the plugin maps exist", "Run tansy sync.");

  let config = null;
  if (hasCmsConfig(cwd)) {
    try {
      config = loadCmsConfig(cwd);
      check(true, "tansy.config.ts loads");
      const stale = staleMaps({ cwd });
      check(!stale.length, "the plugin maps match tansy.config.ts", `Out of date: ${stale.join(", ")}. Run tansy sync.`);
    } catch (error) {
      check(false, "tansy.config.ts loads", error.message);
    }
  }

  check(/^(file:|postgres(ql)?:\/\/)/i.test(env.DATABASE_URL ?? ""), "DATABASE_URL is a SQLite file or Postgres address", "Set DATABASE_URL, or run tansy init.");
  check((env.BETTER_AUTH_SECRET ?? "").length >= MIN_SECRET, "BETTER_AUTH_SECRET is long enough", `Use at least ${MIN_SECRET} random characters, such as openssl rand -base64 32.`);
  check(env.TANSY_ENCRYPTION_KEY, "TANSY_ENCRYPTION_KEY is set", "Stored SMTP and OAuth secrets need it. Use openssl rand -base64 32.");
  check(env.BETTER_AUTH_URL, "BETTER_AUTH_URL is set", "Set it to this server's public address. Email links are built from it.");
  for (const client of ["client-sqlite", "client-postgres"]) check(existsSync(path.join(PACKAGE, "generated", client)), `Prisma ${client} is present`, "Reinstall tansy, or in a clone run npm install.");
  backups({ config, env, check, warn });
  unsafeSettings({ cwd, env, warn });
  scopeProviders({ config, check });
  await pluginChecks({ config, env, cwd, check, warn });

  for (const { ok, label, fix, warning } of results) console.log(ok ? `  ok    ${label}` : `  ${warning ? "WARN" : "FAIL"}  ${label}\n        ${fix}`);
  const themes = config?.theme ? [config.theme] : config?.themes ?? [];
  // The first is the default, and a scope value such as a tenant may choose any of them under Site.
  if (themes.length) console.log(`\nTheme${themes.length > 1 ? "s" : ""}: ${themes.map((theme, index) => `${theme.name} ${theme.version}${index === 0 && themes.length > 1 ? " (default)" : ""}`).join(", ")}`);
  if (config?.plugins?.length) {
    // Plugins are trusted code. This is what to read before keeping one.
    console.log("\nPlugins, with what each one exposes:");
    printPlugins(config, env.NEXT_PUBLIC_TANSY_API_PATH ?? "/api", (line) => console.log(`  ${line}`));
  }
  return results.every((result) => result.ok || result.warning);
}
