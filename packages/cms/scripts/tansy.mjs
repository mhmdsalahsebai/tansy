#!/usr/bin/env node
/**
 * Command-line helpers.
 *
 *   tansy init [--database-url <url>] [--url <public url>] [--admin <path>] [--api <path>] [--site]   Add the CMS to this Next.js app. --site adds a page that renders the theme.
 *   tansy sync [--check]                         Write the plugin import maps in .tansy/. Runs by itself in dev and build.
 *   tansy routes                                 List every route plugins and hook files add, with its access.
 *   tansy doctor                                 Check this app's setup, and list what its plugins expose.
 *   tansy plugin new <name> [--package <npm name>]   Write a plugin package in plugins/<name>.
 *   tansy field new <name> [--plugin <folder>]   Add a field type to a plugin made with tansy plugin new.
 *   tansy theme new <name> [--package <npm name>]    Write a theme package in themes/<name>.
 *   tansy migrate                                Apply database migrations.
 *   tansy superadmin <email>                     Create or recover a superadmin.
 *   tansy types [--url <url>] [--out <file>]     Generate types from a running server.
 *   tansy tick [--url <url>] [--every <seconds>] Run background work once on a server with TANSY_BACKGROUND=external, or every so many seconds.
 *   tansy backup [--out <file or folder>] [--no-files]   Back up the database and uploads, to backups.adapter or --out.
 *   tansy backup list                            List the backups in backups.adapter.
 *   tansy backup verify [<file | name | latest>] Check that a backup is whole and readable.
 *   tansy restore [<file | name | latest>] [--no-files] [--yes] [--force] [--no-safety-copy | --safety-dir <folder>]
 *                                              Replace the database and files with a backup. Stop the server first.
 *
 * In a clone of the repository, run these as npm run tansy -- <command>.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createJiti } from "jiti";
import { pluginCommands, runPluginCommand } from "./commands.mjs";
import { doctor, printPlugins } from "./doctor.mjs";
import { initHost } from "./init.mjs";
import { newField, newPlugin, newTheme } from "./scaffold.mjs";
import { hasCmsConfig, loadCmsConfig, staleMaps, sync } from "./sync.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    url: { type: "string" },
    out: { type: "string" },
    "database-url": { type: "string", default: "file:./dev.db" },
    admin: { type: "string", default: "/dashboard" },
    api: { type: "string", default: "/api" },
    check: { type: "boolean", default: false },
    site: { type: "boolean", default: false },
    package: { type: "string" },
    plugin: { type: "string" },
    files: { type: "boolean" },
    yes: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "safety-copy": { type: "boolean", default: true },
    "safety-dir": { type: "string" },
    every: { type: "string" },
    in: { type: "string" },
    tenant: { type: "string" },
  },
});

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const USAGE = "Usage: tansy <init | sync | routes | doctor | migrate | superadmin <email> | types | tick | backup [list | verify] | restore [<backup>] | plugin new <name> | field new <name> | theme new <name>>";

function writeEnv() {
  // Never replaced: its secrets protect existing data.
  if (existsSync(".env")) return false;
  const secret = () => randomBytes(32).toString("base64");
  const sqlite = values["database-url"].startsWith("file:");
  const lines = [
    "# Written by tansy init. Keep it out of version control, and keep a copy of these secrets",
    "# somewhere else: a backup can only be restored with the secrets it was made under.",
    "",
    ...(sqlite
      ? [
        "# A SQLite file beside the app, created by tansy migrate. Good for development, and for one",
        "# server whose disk is backed up. For anything else use Postgres — and choose before you",
        "# have content, because records don't move between the two. See https://github.com/mhmdsalahsebai/tansy/blob/main/docs/guides/production.md.",
        "#   DATABASE_URL=postgres://user:password@host:5432/name",
      ]
      : ["# Connections the record layer may open. 10 unless DATABASE_POOL_SIZE says otherwise."]),
    `DATABASE_URL="${values["database-url"]}"`,
    "",
    "# openssl rand -base64 32. Sessions and cookies are signed with it.",
    `BETTER_AUTH_SECRET="${secret()}"`,
    "# The public address of this server. Email links and OAuth redirects are built from it.",
    `BETTER_AUTH_URL="${values.url ?? "http://localhost:3000"}"`,
    "# Encrypts the SMTP and OAuth secrets kept in the database.",
    `TANSY_ENCRYPTION_KEY="${secret()}"`,
    "# Encrypts backups. Keep a copy somewhere other than the backups, or they can't be restored.",
    `TANSY_BACKUP_KEY="${secret()}"`,
    "# Lets a cron service call the background endpoint where the host keeps no timers running, as on Vercel.",
    `CRON_SECRET="${secret()}"`,
    "",
    "# Uploads go to local disk, which tansy.config.ts sets up and which production refuses unless",
    "# ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true. Set S3_BUCKET and its credentials for any",
    "# S3-compatible service, or install a storage plugin. See https://github.com/mhmdsalahsebai/tansy/blob/main/docs/guides/storage.md.",
    "",
  ];
  writeFileSync(".env", lines.join("\n"), { mode: 0o600 });
  return true;
}

function init() {
  if (!existsSync("package.json")) fail("Run this in the root of a Next.js app.");
  for (const value of [values.admin, values.api]) {
    if (!/^(\/[a-z0-9][a-z0-9-]*)+$/.test(value)) fail(`Paths look like "/admin", in lowercase. Got "${value}".`);
  }
  const report = initHost({ cwd: process.cwd(), admin: values.admin, api: values.api, site: values.site });
  const list = (title, items) => items.length && console.log(`${title}\n${items.map((item) => `  ${item}`).join("\n")}`);
  list("Wrote:", report.written);
  list("Moved:", report.moved);
  list("Changed:", report.changed);
  list("Kept as they were:", report.kept);
  console.log(writeEnv() ? "Wrote .env with new secrets." : "Kept the existing .env.");
  list("To do by hand:", report.manual);
  console.log("Next: tansy migrate, then next dev. The first-run link is printed in the server's output.");
  console.log(`This app is set up the way it is meant to start: a SQLite file and uploads on local disk.\nBefore a real deployment, read https://github.com/mhmdsalahsebai/tansy/blob/main/docs/guides/production.md.`);
}

function migrate() {
  // Absolute, so Prisma opens the same SQLite file the server does, whichever folder each one starts in.
  const url = process.env.DATABASE_URL ?? "";
  let env = process.env;
  if (url.startsWith("file:")) {
    const file = path.resolve(url.slice("file:".length));
    // A file: URL may name a folder of its own, such as file:./.data/dev.db. Prisma creates the file, never the folder.
    mkdirSync(path.dirname(file), { recursive: true });
    env = { ...process.env, DATABASE_URL: `file:${file}` };
  }
  // The package's own copy, which a strict installer doesn't put on any other path.
  const prisma = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prisma, "migrate", "deploy", "--config", path.join(import.meta.dirname, "../prisma.config.ts")], { stdio: "inherit", env });
}

async function types() {
  const key = process.env.TANSY_API_KEY;
  if (!key) fail("Set TANSY_API_KEY to an API key with collection:read.");
  const response = await fetch(new URL(`${process.env.NEXT_PUBLIC_TANSY_API_PATH ?? "/api"}/schema/types`, values.url ?? process.env.TANSY_URL ?? "http://localhost:3000"), { headers: { "x-api-key": key } });
  if (!response.ok) fail(`The server answered ${response.status}: ${await response.text()}`);
  const out = values.out ?? "cms-types.ts";
  writeFileSync(out, await response.text());
  console.log(`Wrote ${out}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls the background endpoint, as Vercel Cron would: for a host with no cron of its own, run
 * it with --every in a small container or a systemd timer beside the site.
 */
async function tick() {
  const secret = process.env.CRON_SECRET;
  if (!secret) fail("Set CRON_SECRET to the value the server has.");
  const every = values.every === undefined ? 0 : Number(values.every);
  if (!Number.isFinite(every) || every < 0 || (every > 0 && every < 10)) fail("--every takes a number of seconds, at least 10.");
  const url = new URL(`${process.env.NEXT_PUBLIC_TANSY_API_PATH ?? "/api"}/background`, values.url ?? process.env.TANSY_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
  for (;;) {
    const started = Date.now();
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
      const text = await response.text();
      if (!response.ok) {
        if (!every) fail(`The server answered ${response.status}: ${text}`);
        console.error(`${new Date().toISOString()} ${response.status}: ${text}`);
      } else {
        console.log(`${new Date().toISOString()} ${text}`);
      }
    } catch (error) {
      if (!every) throw error;
      console.error(`${new Date().toISOString()} ${error.message}`);
    }
    if (!every) return;
    await sleep(Math.max(0, every * 1000 - (Date.now() - started)));
  }
}

/** Core's backup code, which is TypeScript, loaded the way tansy.config.ts is. */
async function backupTools() {
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "server-only": path.join(import.meta.dirname, "empty.mjs") } });
  // TypeScript in a clone, compiled JavaScript in the published package.
  const base = path.join(import.meta.dirname, "../core/backup/cli");
  return jiti.import(existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.js`);
}

const backupConfig = () => (hasCmsConfig(process.cwd()) ? loadCmsConfig(process.cwd()) : {});

function ask(question) {
  if (!process.stdin.isTTY) fail("Run this in a terminal, or pass --yes.");
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    prompt.question(question, (answer) => {
      prompt.close();
      resolve(answer);
    });
  });
}

async function backup() {
  const tools = await backupTools();
  const config = backupConfig();
  const action = positionals[1];
  if (action === "list") return tools.listCommand(config);
  if (action === "verify") return tools.verifyCommand(config, positionals[2]);
  if (action) fail("Usage: tansy backup [--out <file or folder>] [--no-files] | tansy backup list | tansy backup verify [<file | name | latest>]");
  await tools.backupCommand(config, { out: values.out, files: values.files });
}

async function restore() {
  const tools = await backupTools();
  await tools.restoreCommand(backupConfig(), positionals[1], {
    files: values.files ?? true,
    yes: values.yes,
    force: values.force,
    safetyCopy: values["safety-copy"],
    safetyDir: values["safety-dir"],
    migrationsDir: (kind) => path.join(import.meta.dirname, "../prisma", kind === "postgres" ? "migrations-postgres" : "migrations"),
    migrate,
    ask,
  });
}

/** Read from the terminal without echoing, so the password stays out of shell history and off the screen. */
function askPassword() {
  if (process.env.TANSY_ADMIN_PASSWORD) return Promise.resolve(process.env.TANSY_ADMIN_PASSWORD);
  if (!process.stdin.isTTY) fail("Run this in a terminal, or set TANSY_ADMIN_PASSWORD.");
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    prompt.question("New password: ", (answer) => {
      prompt.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    prompt._writeToOutput = () => {};
  });
}

/** One small interface over both drivers. Statements use $1-style placeholders. */
async function openDatabase() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) fail("Set DATABASE_URL.");
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return {
      flag: (value) => value,
      query: async (text, params) => (await client.query(text, params)).rows,
      close: () => client.end(),
    };
  }
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(url.replace(/^file:/, ""), { timeout: 10_000, fileMustExist: true });
  return {
    flag: (value) => (value ? 1 : 0),
    query: async (text, params) => {
      const statement = database.prepare(text.replace(/\$\d+/g, "?"));
      return statement.reader ? statement.all(...params) : (statement.run(...params), []);
    },
    close: () => database.close(),
  };
}

const MIN_PASSWORD = 15;

/**
 * For when nobody can sign in. Whoever can run this already controls the server.
 * It clears two-factor and any ban on the account, because those may be what locked
 * it, and ends its sessions. The first-run link covers an instance with no superadmin.
 */
async function superadmin() {
  const email = positionals[1]?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) fail("Usage: tansy superadmin <email>");
  const password = await askPassword();
  if (password.length < MIN_PASSWORD) fail(`Use at least ${MIN_PASSWORD} characters.`);
  const { default: argon2 } = await import("argon2");
  // Must match lib/argon2/index.ts.
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const db = await openDatabase();
  const now = new Date().toISOString();
  try {
    await db.query("BEGIN", []);
    const [existing] = await db.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await db.query(`UPDATE "user" SET role = 'superadmin', banned = $1, "banReason" = NULL, "banExpires" = NULL, "twoFactorEnabled" = $2, "updatedAt" = $3 WHERE id = $4`, [db.flag(false), db.flag(false), now, id]);
    } else {
      await db.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES ($1, 'Administrator', $2, $3, 'superadmin', $4, $5)`, [id, email, db.flag(true), now, now]);
    }
    await db.query(`DELETE FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`, [id]);
    await db.query(`INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $3, $4, $5, $6)`, [randomUUID(), id, id, hash, now, now]);
    await db.query(`DELETE FROM "twoFactor" WHERE "userId" = $1`, [id]);
    await db.query(`DELETE FROM "session" WHERE "userId" = $1`, [id]);
    await db.query(`INSERT INTO "AuditLog" (id, at, action, outcome, "actorEmail", "actorKind", "targetType", "targetId") VALUES ($1, $2, 'auth.cli_recovery', 'success', $3, 'system', 'user', $4)`, [randomUUID(), now, email, id]);
    await db.query("COMMIT", []);
    console.log(`${email} is now a superadmin. Two-factor was cleared and existing sessions were ended.`);
  } catch (error) {
    await db.query("ROLLBACK", []).catch(() => {});
    throw error;
  } finally {
    await db.close();
  }
}

function runSync() {
  const cwd = process.cwd();
  if (!hasCmsConfig(cwd)) fail("No tansy.config.ts here. Run this in the app's root, or run tansy init first.");
  if (values.check) {
    const stale = staleMaps({ cwd });
    if (stale.length) fail(`Out of date: ${stale.join(", ")}. Run tansy sync.`);
    console.log("The plugin maps are up to date.");
    return;
  }
  const changed = sync({ cwd });
  console.log(changed.length ? `Wrote ${changed.join(", ")}` : "The plugin maps are up to date.");
}

function routes() {
  const cwd = process.cwd();
  if (!hasCmsConfig(cwd)) fail("No tansy.config.ts here. Run this in the app's root.");
  printPlugins(loadCmsConfig(cwd), process.env.NEXT_PUBLIC_TANSY_API_PATH ?? "/api");
}

/** Only `new` so far, and the word is required so that later subcommands can't change what a command means. */
const scaffoldName = (kind) => {
  if (positionals[1] !== "new" || !positionals[2]) fail(`Usage: tansy ${kind} new <name>`);
  return positionals[2];
};

function packageSteps({ folder, files, importLine, configEntry }, kind) {
  console.log(`Wrote ${files.length} files in ${folder}.\n`);
  console.log(`To try it here:\n  npm install ./${folder}\n  In tansy.config.ts: ${importLine}\n  Then add ${configEntry}${kind === "plugin" ? " to plugins" : ""}, and restart next dev.\n`);
  console.log(`To publish it: npm publish, from ${folder}.`);
}

function plugin() {
  packageSteps(newPlugin({ cwd: process.cwd(), name: scaffoldName("plugin"), packageName: values.package }), "plugin");
}

function field() {
  const { type, files } = newField({ cwd: process.cwd(), name: scaffoldName("field"), plugin: values.plugin });
  console.log(`Added the field type ${type}:\n${files.map((file) => `  ${file}`).join("\n")}`);
}

function theme() {
  packageSteps(newTheme({ cwd: process.cwd(), name: scaffoldName("theme"), packageName: values.package }), "theme");
}

async function runDoctor() {
  if (!(await doctor({ cwd: process.cwd() }))) process.exit(1);
}

const commands = { init, sync: runSync, routes, doctor: runDoctor, migrate, superadmin, types, tick, backup, restore, plugin, field, theme };

/**
 * A name that isn't one of core's own may be a plugin's, such as `tansy tenant` from the
 * multi-tenant plugin. Only looked for in an app with a tansy.config.ts, and core's own names win,
 * so a plugin can never change what a command means.
 */
function pluginCommand(name) {
  if (!name || !hasCmsConfig(process.cwd())) return null;
  return pluginCommands(process.cwd(), Object.keys(commands)).get(name) ?? null;
}

const name = positionals[0];
const command = commands[name];
const fromPlugin = command ? null : pluginCommand(name);
if (!command && !fromPlugin) {
  const added = hasCmsConfig(process.cwd()) ? [...pluginCommands(process.cwd(), Object.keys(commands)).values()] : [];
  fail(added.length ? `${USAGE}\n\nFrom this app's plugins:\n${added.map(({ command: one }) => `  ${one.usage}\n      ${one.describe}`).join("\n")}` : USAGE);
}
try {
  if (command) await command();
  else await runPluginCommand(fromPlugin, { args: positionals.slice(1), flags: values, fail });
} catch (error) {
  fail(`${name} failed: ${error.message}`);
}
