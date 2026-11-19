import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrations = (folder: string) => readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

describe("migrations", () => {
  const sqlite = migrations("packages/cms/prisma/migrations");
  const postgres = migrations("packages/cms/prisma/migrations-postgres");
  const baseline = postgres[0];

  it("start Postgres from one baseline", () => expect(baseline).toMatch(/_baseline$/));

  it("cover both databases for every change after that baseline", () => {
    const stamp = (name: string) => name.slice(name.indexOf("_") + 1);
    const later = sqlite.filter((name) => name > baseline).map(stamp);
    expect(postgres.slice(1).map(stamp)).toEqual(later);
  });

  it("declare the right provider", () => {
    expect(readFileSync("packages/cms/prisma/migrations/migration_lock.toml", "utf8")).toContain('provider = "sqlite"');
    expect(readFileSync("packages/cms/prisma/migrations-postgres/migration_lock.toml", "utf8")).toContain('provider = "postgresql"');
  });
});
