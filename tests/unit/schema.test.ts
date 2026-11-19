import { describe, expect, it } from "vitest";
import { addColumn, columnConversion, columnFromUniqueError, ident, renameColumn } from "@/core/schema/ddl";
import { diffFields, type StoredField } from "@/core/schema/diff";
import { fieldNameProblem, tableName } from "@/core/schema/names";

const stored = (id: number, name: string, type = "text", config: unknown = {}): StoredField => ({ id, name, type, config });
const kinds = (result: ReturnType<typeof diffFields>) => result.changes.map((c) => c.kind);

describe("names", () => {
  it.each(["title", "Title_2", "a"])("allows %s", (name) => expect(fieldNameProblem(name)).toBeNull());
  it.each(["", "2fast", "has space", "semi;colon", 'quo"te', "dash-ed", "_x", "id", "ID", "createdAt", "createdat", "status", "rowid", "x".repeat(64)])("rejects %j", (name) => {
    expect(fieldNameProblem(name)).not.toBeNull();
  });
  it("maps slugs to table names", () => expect(tableName("blog-posts")).toBe("rec_blog_posts"));
});

describe("DDL", () => {
  it("escapes quotes in identifiers", () => {
    expect(ident('a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
    expect(renameColumn("t", 'a"', "b")).toBe('ALTER TABLE "t" RENAME COLUMN "a""" TO "b"');
  });
  it("maps storage kinds to SQLite columns", () => {
    expect(addColumn("t", "c", "json")).toBe('ALTER TABLE "t" ADD COLUMN "c" TEXT');
    expect(addColumn("t", "c", "boolean")).toBe('ALTER TABLE "t" ADD COLUMN "c" INTEGER');
    expect(addColumn("t", "c", "real")).toBe('ALTER TABLE "t" ADD COLUMN "c" REAL');
  });
  it("finds the column behind a unique violation", () => {
    expect(columnFromUniqueError("UNIQUE constraint failed: rec_posts.code")).toBe("code");
    expect(columnFromUniqueError("CHECK constraint failed: status")).toBeNull();
  });
  it("marks only conversions that can lose values as lossy", () => {
    expect(columnConversion("real", "text", "c")?.lossy).toBe(false);
    expect(columnConversion("text", "real", "c")?.lossy).toBe(true);
    expect(columnConversion("text", "boolean", "c")?.lossy).toBe(true);
    expect(columnConversion("json", "text", "c")).toBeNull();
    expect(columnConversion("integer", "text", "c")).toBeNull();
  });
});

describe("diffFields with a field whose plugin was removed", () => {
  const orphan = stored(1, "a", "gone_type", { anything: true });

  it("keeps it unchanged, even if the form's config differs", () => {
    expect(diffFields([orphan], [{ id: 1, name: "a", type: "gone_type", config: {} }])).toMatchObject({ changes: [], issues: [] });
  });

  it("can remove it", () => {
    expect(kinds(diffFields([orphan], []))).toEqual(["remove"]);
  });

  it("refuses to rename or convert it", () => {
    expect(diffFields([orphan], [{ id: 1, name: "b", type: "gone_type" }]).issues).toHaveLength(1);
    expect(diffFields([orphan], [{ id: 1, name: "a", type: "text" }]).issues).toHaveLength(1);
  });
});

describe("diffFields", () => {
  it("adds, keeps and removes fields", () => {
    const result = diffFields([stored(1, "a"), stored(2, "b")], [{ id: 1, name: "a", type: "text" }, { name: "c", type: "number" }]);
    expect(kinds(result)).toEqual(["remove", "add"]);
    expect(result.issues).toEqual([]);
  });
  it("orders removals before additions so a name can be reused", () => {
    const result = diffFields([stored(1, "a")], [{ name: "a", type: "number" }]);
    expect(kinds(result)).toEqual(["remove", "add"]);
    expect(result.issues).toEqual([]);
  });
  it("is a no-op when nothing changes", () => {
    expect(diffFields([stored(1, "a", "text", { required: true })], [{ id: 1, name: "a", type: "text", config: { required: true } }]).changes).toEqual([]);
  });
  it("requires confirmation to remove a field", () => {
    expect(diffFields([stored(1, "a")], []).destructive[0].path).toBe("a");
  });
  it("needs no confirmation for a safe conversion, but does for a lossy one", () => {
    expect(diffFields([stored(1, "a", "number")], [{ id: 1, name: "a", type: "text" }]).destructive).toEqual([]);
    expect(diffFields([stored(1, "a")], [{ id: 1, name: "a", type: "number" }]).destructive[0].path).toBe("fields.0.type");
  });
  it("needs no DDL between types with the same column", () => {
    const [change] = diffFields([stored(1, "a")], [{ id: 1, name: "a", type: "email" }]).changes;
    expect(change).toMatchObject({ kind: "update", conversion: null });
  });
  it("refuses unsupported conversions", () => {
    expect(diffFields([stored(1, "a", "json")], [{ id: 1, name: "a", type: "text" }]).issues[0].path).toBe("fields.0.type");
    expect(diffFields([stored(1, "a", "number")], [{ id: 1, name: "a", type: "checkbox", config: { options: [{ label: "x", value: "x" }] } }]).issues[0].path).toBe("fields.0.type");
    expect(diffFields([stored(1, "a", "reference", { collection: 1 })], [{ id: 1, name: "a", type: "reference", config: { collection: 2 } }]).issues[0].path).toBe("fields.0.type");
    expect(diffFields([stored(1, "a", "reference", { collection: 1 })], [{ id: 1, name: "a", type: "reference", config: { collection: 1, allowMultiple: true } }]).issues[0].path).toBe("fields.0.type");
  });
  it("reports invalid names, duplicates, foreign ids and bad config with paths", () => {
    const paths = diffFields([stored(1, "a")], [
      { name: "bad name", type: "text" },
      { name: "b", type: "text" },
      { name: "B", type: "text" },
      { id: 99, name: "c", type: "text" },
      { name: "d", type: "unknown" },
    ]).issues.map((i) => i.path);
    expect(paths).toEqual(["fields.0.name", "fields.2.name", "fields.3.id", "fields.4.type"]);
  });
  it("refuses the same id twice", () => {
    expect(diffFields([stored(1, "a")], [{ id: 1, name: "a", type: "text" }, { id: 1, name: "b", type: "text" }]).issues[0].path).toBe("fields.1.id");
  });
  it("refuses swapping names in one request", () => {
    const result = diffFields([stored(1, "a"), stored(2, "b")], [{ id: 1, name: "b", type: "text" }, { id: 2, name: "a", type: "text" }]);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it("allows renaming onto a removed field's name", () => {
    const result = diffFields([stored(1, "a"), stored(2, "b")], [{ id: 2, name: "a", type: "text" }]);
    expect(result.issues).toEqual([]);
    expect(kinds(result)).toEqual(["remove", "update"]);
  });
});
