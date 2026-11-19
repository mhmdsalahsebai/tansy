import { describe, expect, it } from "vitest";
import { createViewSql } from "@/core/schema/ddl";
import { inspectViewQuery } from "@/core/schema/views";

const schema = ['CREATE TABLE "rec_posts" ("id" INTEGER PRIMARY KEY, "status" TEXT, "title" TEXT, "views" INTEGER) STRICT'];
const refused = (query: string) => expect(() => inspectViewQuery(query, schema), query).toThrow();

describe("inspectViewQuery", () => {
  it("reports each column and where it came from", () => {
    const { columns } = inspectViewQuery("SELECT id, title, views + 1 AS next FROM rec_posts", schema);
    expect(columns).toEqual([
      { name: "id", table: "rec_posts", column: "id" },
      { name: "title", table: "rec_posts", column: "title" },
      { name: "next", table: null, column: null },
    ]);
  });
  it("drops one trailing semicolon and allows WITH", () => {
    expect(inspectViewQuery("SELECT id FROM rec_posts;  ", schema).query).toBe("SELECT id FROM rec_posts");
    expect(inspectViewQuery("WITH p AS (SELECT id FROM rec_posts) SELECT id FROM p", schema).columns[0].name).toBe("id");
  });
  it("sees only record tables", () => {
    for (const table of ['"user"', "account", "session", '"AuditLog"', '"AppSetting"', "main.account", "rec_missing"]) refused(`SELECT id FROM ${table}`);
    refused('SELECT id FROM rec_posts WHERE id IN (SELECT id FROM "user")');
  });
  it("blocks internals that exist in every database", () => {
    for (const query of ["SELECT rowid AS id FROM sqlite_master", 'SELECT rowid AS id FROM "sqlite_schema"', "SELECT rowid AS id FROM [SQLITE_MASTER]", "SELECT 1 AS id, name FROM pragma_database_list", "SELECT 1 AS id FROM dbstat", "SELECT 1 AS id, load_extension('x') AS a"]) refused(query);
  });
  it("accepts only one read-only SELECT", () => {
    for (const query of ["", "DELETE FROM rec_posts", "INSERT INTO rec_posts (id) VALUES (1)", "SELECT id FROM rec_posts; SELECT id FROM rec_posts", "PRAGMA foreign_keys", "ATTACH 'x' AS y", "SELECT id, ? AS a FROM rec_posts"]) refused(query);
    refused(`SELECT id FROM rec_posts${" ".repeat(10_001)}x`);
  });
  it("can't escape the wrapper it is created in", () => {
    refused("SELECT id FROM rec_posts) q; DROP TABLE rec_posts; --");
    refused("SELECT id FROM rec_posts /* open");
    expect(inspectViewQuery("SELECT id FROM rec_posts -- note", schema).columns).toHaveLength(1);
  });
  it("needs a unique, usable set of columns", () => {
    refused("SELECT title FROM rec_posts");
    refused("SELECT id, title, title FROM rec_posts");
    refused("SELECT id, count(*) FROM rec_posts");
    refused('SELECT id, title AS "expand" FROM rec_posts');
  });
});

describe("createViewSql", () => {
  it("fills in only the system columns the query left out", () => {
    const sql = createViewSql("v", "SELECT id, status FROM t", ["id", "status"]);
    expect(sql).not.toContain("'published' AS");
    expect(sql).toContain('NULL AS "createdAt"');
    expect(createViewSql("v", "SELECT id FROM t", ["id"])).toContain(`'published' AS "status"`);
  });
});
