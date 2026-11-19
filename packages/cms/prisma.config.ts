import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Absolute, because this runs from the app's folder as well as this one.
const here = import.meta.dirname;

// These commands compare against the live database, which holds runtime `rec_*` tables Prisma doesn't know about.
// `db push` would drop them, `migrate dev` offers a reset, and `db pull` would write them into the schema.
const [command, subcommand] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (["db push", "db pull", "migrate dev"].includes(`${command} ${subcommand}`)) {
  throw new Error(`"prisma ${command} ${subcommand}" is disabled because it can damage record tables. Use "npm run db:migrate -- <name>" to change the Prisma schema.`);
}

// TANSY_PRISMA_TARGET lets `prisma generate` build both clients without a database.
const url = process.env.DATABASE_URL ?? "";
const target = process.env.TANSY_PRISMA_TARGET ?? (/^postgres(ql)?:\/\//i.test(url) ? "postgres" : "sqlite");
const postgres = target === "postgres";

export default defineConfig({
  schema: path.join(here, postgres ? "generated/schema-postgres" : "prisma/schema"),
  migrations: {
    path: path.join(here, postgres ? "prisma/migrations-postgres" : "prisma/migrations"),
  },
  datasource: {
    // Not env(): it throws when unset, which would break `prisma generate` on a fresh clone without .env.
    url: process.env.DATABASE_URL ?? "",
  },
});
