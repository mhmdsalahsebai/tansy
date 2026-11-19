/**
 * Generates a Prisma client for each supported database, into generated/ so the
 * package can ship them and nothing has to run when it's installed. prisma/schema
 * is the only place models are written. The Postgres copy differs in its provider and output.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PACKAGE = path.resolve(import.meta.dirname, "..");

// Relative to the package, the folder db-migrate.mjs and Prisma's config run from.
export const POSTGRES_SCHEMA = "generated/schema-postgres";

export function writePostgresSchema() {
  const target = path.join(PACKAGE, POSTGRES_SCHEMA);
  const source = path.join(PACKAGE, "prisma/schema");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(source)) {
    const adapted = readFileSync(path.join(source, file), "utf8")
      .replace('provider = "sqlite"', 'provider = "postgresql"')
      .replace('output   = "../../generated/client-sqlite"', 'output   = "../client-postgres"');
    writeFileSync(path.join(target, file), adapted);
  }
}

export function generateClients() {
  writePostgresSchema();
  const generate = (target) => execFileSync("npx", ["prisma", "generate"], { cwd: PACKAGE, stdio: "inherit", env: { ...process.env, TANSY_PRISMA_TARGET: target } });
  generate("sqlite");
  generate("postgres");
}

if (import.meta.url === `file://${process.argv[1]}`) generateClients();
