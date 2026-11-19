/**
 * Creates a Prisma migration without Prisma ever comparing against the real
 * database, which holds runtime `rec_*` tables that Prisma would call drift.
 * The migration is diffed against a throwaway database built from the existing
 * migrations, then applied with `prisma migrate deploy`, which only runs SQL.
 */
import { config as loadEnv } from "dotenv";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { POSTGRES_SCHEMA, writePostgresSchema } from "./prisma-generate.mjs";

// Runs from this package, while .env and any relative SQLite path belong to the app.
const app = path.resolve("../../apps/starter");
loadEnv({ path: path.join(app, ".env"), quiet: true });
if (process.env.DATABASE_URL?.startsWith("file:")) process.env.DATABASE_URL = `file:${path.resolve(app, process.env.DATABASE_URL.slice("file:".length))}`;

const args = process.argv.slice(2);
const createOnly = args.includes("--create-only");
const name = args.find((arg) => !arg.startsWith("-"));

if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error("Usage: npm run db:migrate -- <snake_case_name> [--create-only]");
  process.exit(1);
}

const postgresScratch = process.env.POSTGRES_SCRATCH_URL;
if (!postgresScratch) {
  console.error("Set POSTGRES_SCRATCH_URL to a Postgres database this can use for a temporary schema. Each change needs a migration for both databases.");
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

/** The same steps as SQLite's, against a temporary schema that is dropped afterwards. */
async function writePostgresMigration() {
  writePostgresSchema();
  const schema = `cms_migrate_${timestamp}`;
  const url = new URL(postgresScratch);
  url.searchParams.set("schema", schema);
  const env = { ...process.env, DATABASE_URL: url.toString() };
  const directory = mkdtempSync(path.join(tmpdir(), "cms-migrate-pg-"));
  const script = path.join(directory, "migration.sql");
  const client = new pg.Client({ connectionString: postgresScratch });
  await client.connect();
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { env, stdio: "pipe" });
    const diff = spawnSync("npx", ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", POSTGRES_SCHEMA, "--script", "--exit-code", "-o", script], { env, encoding: "utf8" });
    if (diff.status === 0) return;
    if (diff.status !== 2) throw new Error(`prisma migrate diff failed for Postgres:\n${diff.stderr || diff.stdout}`);
    const target = path.join("prisma", "migrations-postgres", `${timestamp}_${name}`);
    mkdirSync(target);
    copyFileSync(script, path.join(target, "migration.sql"));
    console.log(`Created ${target}/migration.sql`);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
    rmSync(directory, { recursive: true, force: true });
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), "cms-migrate-"));
const scratchEnv = { ...process.env, DATABASE_URL: `file:${path.join(scratch, "schema.db")}` };
const output = path.join(scratch, "migration.sql");

try {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: scratchEnv, stdio: "pipe" });

  // With --exit-code: 0 means no changes, 2 means there is a migration to write.
  const diff = spawnSync("npx", ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema", "--script", "--exit-code", "-o", output], { env: scratchEnv, encoding: "utf8" });
  if (diff.status === 0) {
    console.log("The Prisma schema matches the migrations. Nothing to do.");
    process.exit(0);
  }
  if (diff.status !== 2) throw new Error(`prisma migrate diff failed:\n${diff.stderr || diff.stdout}`);

  const directory = path.join("prisma", "migrations", `${timestamp}_${name}`);
  mkdirSync(directory);
  copyFileSync(output, path.join(directory, "migration.sql"));
  console.log(`Created ${directory}/migration.sql:\n\n${readFileSync(output, "utf8")}`);
  await writePostgresMigration();

  if (createOnly) {
    console.log("Review it, then apply with: npx prisma migrate deploy");
  } else {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit" });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
