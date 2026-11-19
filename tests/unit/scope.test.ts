import Database from "better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unscoped, withScope } from "../../packages/cms/core/scope/context";
import { scopePlugin } from "../../packages/cms/core/scope/plugin";
import { setScopedTablesForTests } from "../../packages/cms/core/scope/registry";

type Tables = Record<string, Record<string, unknown>>;

let db: Kysely<Tables>;

beforeAll(() => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE rec_posts ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "author" INTEGER, "_scope" TEXT);
    CREATE TABLE loc_posts ("recordId" INTEGER, "locale" TEXT, "body" TEXT, "_scope" TEXT);
    CREATE TABLE rec_tags ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT);
    INSERT INTO rec_posts ("title", "author", "_scope") VALUES ('a1', 1, 'a'), ('a2', 2, 'a'), ('b1', 1, 'b');
    INSERT INTO loc_posts VALUES (1, 'en', 'A one', 'a'), (3, 'en', 'B one', 'b');
    INSERT INTO rec_tags ("name") VALUES ('shared');
  `);
  db = new Kysely<Tables>({ dialect: new SqliteDialect({ database }), plugins: [scopePlugin] });
});

afterAll(() => setScopedTablesForTests(null));

beforeEach(() => setScopedTablesForTests(["rec_posts", "loc_posts"]));

const titles = (rows: Array<Record<string, unknown>>) => rows.map((row) => row.title).sort();

describe("row scopes on record tables", () => {
  it("narrows reads to the current scope value", async () => {
    expect(titles(await withScope("a", () => db.selectFrom("rec_posts").selectAll().execute()))).toEqual(["a1", "a2"]);
    expect(titles(await withScope("b", () => db.selectFrom("rec_posts").selectAll().where("id", "=", 1).execute()))).toEqual([]);
  });

  it("narrows aliased tables, subqueries and joins", async () => {
    const aliased = await withScope("b", () => db.selectFrom("rec_posts as p").select("p.title").execute());
    expect(titles(aliased)).toEqual(["b1"]);
    const nested = await withScope("a", () => db.selectFrom("rec_tags").select((eb) => eb.selectFrom("rec_posts").select(sql<number>`count(*)`.as("n")).as("posts")).execute());
    expect(nested).toEqual([{ posts: 2 }]);
    const joined = await withScope("b", () => db.selectFrom("rec_tags").leftJoin("loc_posts", "loc_posts.locale", "loc_posts.locale").select(["rec_tags.name", "loc_posts.body"]).execute());
    expect(joined).toEqual([{ name: "shared", body: "B one" }]);
  });

  it("refuses scoped tables outside a scope, and in a request without one", async () => {
    await expect(Promise.resolve().then(() => db.selectFrom("rec_posts").selectAll().execute())).rejects.toThrow(/outside any scope/);
    await expect(withScope(null, () => db.selectFrom("rec_posts").selectAll().execute())).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("leaves unscoped tables alone", async () => {
    expect(await db.selectFrom("rec_tags").select("name").execute()).toEqual([{ name: "shared" }]);
  });

  it("writes only within the scope, and sets the value on insert", async () => {
    const moved = await withScope("b", () => db.updateTable("rec_posts").set({ title: "hijacked" }).where("id", "=", 1).executeTakeFirst());
    expect(Number(moved.numUpdatedRows)).toBe(0);
    const removed = await withScope("b", () => db.deleteFrom("rec_posts").where("id", "=", 2).executeTakeFirst());
    expect(Number(removed.numDeletedRows)).toBe(0);
    const created = await withScope("b", () => db.insertInto("rec_posts").values({ title: "b2", author: 3 }).returning(["id", "_scope"]).executeTakeFirstOrThrow());
    expect(created._scope).toBe("b");
    await withScope("b", () => db.deleteFrom("rec_posts").where("id", "=", created.id as number).execute());
  });

  it("never lets a caller set or change the column", async () => {
    await expect(withScope("a", () => db.insertInto("rec_posts").values({ title: "x", _scope: "b" }).execute())).rejects.toThrow(/set by core/);
    await expect(unscoped("test", () => db.updateTable("rec_posts").set({ _scope: "b" }).where("id", "=", 1).execute())).rejects.toThrow(/can't be changed/);
    await expect(unscoped("test", () => db.insertInto("rec_posts").values({ title: "x" }).execute())).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("reads across scopes only in trusted work", async () => {
    expect(titles(await unscoped("test", () => db.selectFrom("rec_posts").selectAll().execute()))).toEqual(["a1", "a2", "b1"]);
  });

  it("refuses every record table until the registry has loaded", async () => {
    setScopedTablesForTests(null);
    await expect(Promise.resolve().then(() => db.selectFrom("rec_tags").selectAll().execute())).rejects.toThrow(/before the scope registry loaded/);
  });
});

/**
 * Raw SQL isn't rewritten by the scope plugin. These are the only raw statements naming a
 * record or translation table, and each one was checked: it scopes itself, or it only narrows
 * a query that is already scoped. A new one has to be checked the same way and added here.
 */
const REVIEWED_RAW_TABLE_USES: Record<string, number> = {
  // Two clear a deleted record's id from other records' links, and two put it back on a restore
  // from the trash, over ids a scoped query found. Ids are unique across scopes, and links never
  // cross one. The fifth moves a Postgres table's id sequence past a restored record's own id,
  // which touches no row.
  "core/content/content-service.ts": 5,
  // A subquery of record ids, only ever ANDed with the scoped list query.
  "core/content/public-records.ts": 1,
  // The search index table, keyed by collection and record id, read only to narrow a scoped query.
  "core/search/index.ts": 2,
  // A localized collection's read source, which adds the scope condition itself.
  "core/i18n/storage.ts": 6,
  // After an import keeps its record ids, moves a Postgres table's id sequence past the highest id in every scope.
  "core/scope/data.ts": 1,
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("raw SQL on record tables", () => {
  it("is limited to statements reviewed for row scopes", () => {
    const root = path.resolve(__dirname, "../../packages/cms");
    const found: Record<string, number> = {};
    for (const file of sourceFiles(path.join(root, "core"))) {
      const uses = readFileSync(file, "utf8").match(/sql\.table\((?!"(RecordRef|FileRef)")/g)?.length ?? 0;
      if (uses) found[path.relative(root, file)] = uses;
    }
    expect(found).toEqual(REVIEWED_RAW_TABLE_USES);
  });
});
