import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql, type SqlBool } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";
import { compiled, evaluateNode, evaluateRule, nodeKey, validateFilter, validateRule, type RuleContext } from "@/core/authz/rules/evaluate";
import { compileRule, narrowingWhere, registerRuleFunctions } from "@/core/authz/rules/sql";
import { parseExpand, parseFields, parseSort, pickFields, recordListQuery } from "@/core/content/query";
import type { ColumnType } from "@/core/fields/define";
import { fieldNameProblem } from "@/core/schema/names";

const columns = new Map<string, ColumnType>([["id", "integer"], ["status", "text"], ["title", "text"], ["views", "real"], ["meta", "json"]]);

const request: RuleContext["request"] = { auth: { id: "u1" }, body: {}, query: {}, headers: {}, method: "GET", context: "default" };

const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("sort", () => {
  it("parses directions and leaves spaces from a decoded + alone", () => {
    expect(parseSort("-views, title,+status", columns)).toEqual([
      { column: "views", direction: "desc" },
      { column: "title", direction: "asc" },
      { column: "status", direction: "asc" },
    ]);
  });
  it.each(["secret", "title;DROP TABLE x", 'title" DESC --', "(select 1)", "rowid", "--title"])("refuses %s", (value) => {
    expect(code(() => parseSort(value, columns))).toBe("INVALID_SORT");
  });
  it("limits the number of terms", () => {
    expect(code(() => parseSort(Array(9).fill("title").join(","), columns))).toBe("INVALID_SORT");
  });
});

describe("expand", () => {
  it("builds a tree that shares prefixes", () => {
    const tree = parseExpand("author,author.company,notes_via_post");
    expect([...tree.keys()]).toEqual(["author", "notes_via_post"]);
    expect([...tree.get("author")!.keys()]).toEqual(["company"]);
  });
  it.each(["a.b.c.d.e", 'author"', "author;--", "a b", "author..company"])("refuses %s", (value) => {
    expect(code(() => parseExpand(value))).toBe("INVALID_EXPAND");
  });
  it("limits the number of paths", () => {
    expect(code(() => parseExpand(Array.from({ length: 9 }, (_, i) => `a${i}`).join(",")))).toBe("INVALID_EXPAND");
  });
});

describe("fields", () => {
  const record = { id: 1, title: "T", secret: "s", expand: { author: { name: "A", email: "e" }, tags: [{ id: 1, label: "x" }] } };
  const pick = (value: string) => pickFields(record, parseFields(value)!);

  it("returns everything when not given", () => {
    expect(parseFields(undefined)).toBeNull();
    expect(parseFields(" , ")).toBeNull();
  });
  it("selects by path, through objects and arrays", () => {
    expect(pick("id,expand.author.name,expand.tags.label")).toEqual({ id: 1, expand: { author: { name: "A" }, tags: [{ label: "x" }] } });
  });
  it("supports * per level", () => {
    expect(pick("*")).toEqual(record);
    expect(pick("id,expand.author.*")).toEqual({ id: 1, expand: { author: { name: "A", email: "e" } } });
  });
  it("can only narrow a record", () => {
    expect(pick("nothing,__proto__,constructor")).toEqual({});
  });
  it.each(["a;b", 'a"', "a b"])("refuses %s", (value) => {
    expect(code(() => parseFields(value))).toBe("INVALID_FIELDS");
  });
});

describe("list query", () => {
  it("defaults and bounds paging", () => {
    expect(recordListQuery.parse({})).toMatchObject({ page: 1, perPage: 30, skipTotal: false });
    expect(recordListQuery.parse({ skipTotal: "1" }).skipTotal).toBe(true);
    expect(recordListQuery.safeParse({ perPage: "201" }).success).toBe(false);
    expect(recordListQuery.safeParse({ page: "0" }).success).toBe(false);
    expect(recordListQuery.safeParse({ filter: "x".repeat(2049) }).success).toBe(false);
  });
  it("keeps other parameters for @request.query", () => {
    expect(recordListQuery.parse({ token: "t" }).token).toBe("t");
  });
});

describe("filter validation", () => {
  const check = (source: string) => validateFilter(source, columns);

  it("accepts readable columns, nested JSON, macros and the caller's own identity", () => {
    expect(check('title ~ "a" && views > 1 && meta.owner = @request.auth.id && id < @year')).toBeNull();
  });
  it("refuses columns it was not given, which is how hidden fields stay private", () => {
    expect(check('secret = "x"')).toMatch(/Unknown field/);
  });
  it("refuses @collection, which would read past API rules", () => {
    expect(check('@collection.users.email ?= "a@b.c"')).toMatch(/not available/);
  });
  it("refuses relation paths on columns with no nested values", () => {
    expect(check('title.owner = "x"')).toMatch(/no nested values/);
  });
  it.each(["title =", "1 = 1 ; DROP TABLE x", '"x" OR 1=1', "title = 'a", "(title = 1", "title = 1) OR (1 = 1"])("rejects malformed %s", (source) => {
    expect(check(source)).not.toBeNull();
  });
});

describe("filters that follow a relation", () => {
  // What relationCatalog() builds: the relations this filter may follow, with the target fields the caller may read.
  const relations = new Map([["author", new Set(["id", "name"])], ["comments_via_post", new Set(["id", "body"])]]);
  const follow = (source: string) => validateFilter(source, columns, undefined, relations);

  it("accepts a field of a relation it was given, forwards and in reverse", () => {
    expect(follow('author.name = "x"')).toBeNull();
    expect(follow('comments_via_post.body ?~ "x"')).toBeNull();
  });
  it("still accepts the relation's own column", () => {
    expect(follow("author = 7")).toBeNull();
  });
  it("names the field it can't filter on, rather than refusing the whole path", () => {
    expect(follow('author.email = "x"')).toMatch(/no field "email"/);
  });
  it("refuses a relation it was not given, which is how a filter can't follow one everywhere", () => {
    expect(validateFilter('author.name = "x"', columns)).toMatch(/Unknown field/);
    expect(validateFilter('meta.owner = "x"', columns)).toBeNull();
  });
});

describe("filters reach SQL only as parameters", () => {
  const database = new Database(":memory:");
  registerRuleFunctions(database);
  database.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, status TEXT, title TEXT, views REAL, meta TEXT)`);
  database.exec(`INSERT INTO posts (status, title, views, meta) VALUES ('published', 'Hello', 1, '{}'), ('draft', 'x'' OR 1=1 --', 2, '{}')`);
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database }) });
  afterAll(() => db.destroy());

  const titles = async (filter: string) => {
    const rows = await db.selectFrom("posts").select("title").where(compileRule(filter, columns, { request })).execute();
    return rows.map((row) => row.title);
  };

  it.each([
    `title = "x' OR 1=1 --"`,
    `title = 'nope\\' OR 1=1 --'`,
    `title = "nope\\" OR \\"1\\"=\\"1"`,
    `title = "'; DROP TABLE posts; --"`,
    `title = "nope" || title = "'); DELETE FROM posts; --"`,
  ])("treats %s as data", async (filter) => {
    expect(validateFilter(filter, columns)).toBeNull();
    const found = await titles(filter);
    expect(found.every((title) => title === "x' OR 1=1 --")).toBe(true);
    expect((database.prepare("SELECT count(*) AS n FROM posts").get() as { n: number }).n).toBe(2);
  });

  it("denies a path it has nothing resolved for, rather than comparing a value the row doesn't have", async () => {
    // Without this, `!=` against a path the record can't answer would match every row.
    expect(await titles('title.owner != "x"')).toEqual([]);
    expect(await titles('title.owner = "x"')).toEqual([]);
  });

  it("uses the condition a relation path was resolved to", async () => {
    const source = 'author.name = "x"';
    const relations = new Map([[nodeKey(compiled(source)), sql<SqlBool>`"title" = 'Hello'`]]);
    const where = compileRule(source, new Map([...columns, ["author", "integer" as ColumnType]]), { request }, relations);
    const rows = await db.selectFrom("posts").select("title").where(where).execute();
    expect(rows.map((row) => row.title)).toEqual(["Hello"]);
  });

  it("never puts a value in the statement text", () => {
    const compiled = sql`SELECT 1 WHERE ${compileRule(`title = "PAYLOAD"`, columns, { request })}`.compile(db);
    expect(compiled.sql).not.toContain("PAYLOAD");
    expect(compiled.parameters).toContain(JSON.stringify("PAYLOAD"));
  });
});

describe("wildcard matching", () => {
  const like = (value: string, pattern: string) => evaluateRule(`title ~ "${pattern}"`, { record: { title: value }, request });

  it("keeps its meaning", () => {
    expect(like("Hello World", "lo wo")).toBe(true);
    expect(like("Hello World", "hello%")).toBe(true);
    expect(like("Hello World", "%world")).toBe(true);
    expect(like("Hello World", "h%o%d")).toBe(true);
    expect(like("Hello World", "world%")).toBe(false);
    expect(like("Hello World", "%hello")).toBe(false);
    expect(like("aXa", "a%a%a")).toBe(false);
    expect(like("line\nbreak", "line%break")).toBe(true);
    expect(like("a.c", "a.%")).toBe(true);
    expect(like("abc", "a.%")).toBe(false);
  });
  it("does not blow up on many wildcards", () => {
    const started = performance.now();
    like("a".repeat(100_000), `${"%a".repeat(900)}%b`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("@collection in rules", () => {
  const catalog = new Map([["team-members", new Set(["user", "active"])]]);
  const valid = (source: string) => validateRule(source, ["title"], catalog);

  it("accepts known collections, written with underscores", () => {
    expect(valid("@collection.team_members.user ?= @request.auth.id")).toBeNull();
    expect(valid('@collection.team_members.status ?= "published"')).toBeNull();
  });
  it("rejects typos and misuse when saved", () => {
    expect(valid('@collection.teams.user ?= "x"')).toMatch(/Unknown collection/);
    expect(valid('@collection.team_members.nope ?= "x"')).toMatch(/Unknown field/);
    expect(valid('@collection.team_members = "x"')).toMatch(/Use @collection/);
    expect(valid('@collection.team_members.user:changed = "x"')).toMatch(/only applies/);
  });

  const rule = "@collection.team_members.user ?= @request.auth.id";
  const ctx = (values: unknown[]): RuleContext => ({ record: {}, request, lookup: () => values });

  it("matches any value with ?=", () => {
    expect(evaluateRule(rule, ctx(["u2", "u1"]))).toBe(true);
    expect(evaluateRule(rule, ctx(["u2"]))).toBe(false);
  });
  it("denies when no lookup is available or it fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(evaluateRule(rule, { record: {}, request })).toBe(false);
    expect(evaluateRule(rule, { record: {}, request, lookup: () => { throw new Error("too many"); } })).toBe(false);
    error.mockRestore();
  });
});

describe("field names", () => {
  it("reserves expand for related records", () => {
    expect(fieldNameProblem("expand")).toMatch(/reserved/);
  });
});

describe("narrowing a read without deciding it", () => {
  const database = new Database(":memory:");
  registerRuleFunctions(database);
  database.exec(`CREATE TABLE authors (id INTEGER PRIMARY KEY, status TEXT, name TEXT, rank REAL, meta TEXT)`);
  database.exec(`INSERT INTO authors (status, name, rank, meta) VALUES
    ('published', 'Ada', 3, '{"city":"London"}'),
    ('published', 'Bob', 1, '{"city":"Paris"}'),
    ('draft', 'Ada Two', 2, '{}'),
    ('published', '', 0, 'null')`);
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database }) });
  afterAll(() => db.destroy());

  const authorColumns = new Map<string, ColumnType>([["id", "integer"], ["status", "text"], ["name", "text"], ["rank", "real"], ["meta", "json"]]);
  const all = () => db.selectFrom("authors").selectAll().execute();

  /** The rows SQL hands over, and the rows the evaluator accepts out of every row there is. */
  async function both(filter: string) {
    const node = compiled(filter);
    const where = narrowingWhere(node, authorColumns, { request });
    const read = await (where ? db.selectFrom("authors").selectAll().where(where) : db.selectFrom("authors").selectAll()).execute();
    const decided = (await all()).filter((row) => evaluateNode(node, { record: { ...row, meta: JSON.parse((row.meta as string) ?? "null") }, request }));
    return { pushed: where !== null, read, decided };
  }

  // Every shape a relation path can take, since this is what decides how much of a target collection is read.
  it.each([
    'name = "Ada"',
    'name != "Ada"',
    'name ~ "Ada"',
    'name !~ "Ada"',
    'name ?= "Ada"',
    'name = ""',
    "rank > 1",
    "rank <= 2",
    "id = 3",
    'status = "published" && name ~ "a"',
    'name = "Ada" || rank > 2',
    'meta.city = "London"',
  ])("hands over every row the evaluator accepts, for %s", async (filter) => {
    const { pushed, read, decided } = await both(filter);
    // Every one of these compiles here, so the SQL path is what the soundness check below reads.
    expect(pushed, `${filter} was not pushed down`).toBe(true);
    const ids = new Set(read.map((row) => row.id));
    // Soundness, which is the whole point: narrowing may read more than it must, never less.
    for (const row of decided) expect(ids, `${filter} dropped row ${row.id}`).toContain(row.id);
  });

  it("reads only what can match, so a cap counts matching rows rather than the collection", async () => {
    const { pushed, read, decided } = await both('name = "Ada"');
    expect(pushed).toBe(true);
    expect(decided.map((row) => row.id)).toEqual([1]);
    // One row read instead of four: on a large collection this is the difference between
    // answering and refusing with FILTER_TOO_BROAD.
    expect(read.map((row) => row.id)).toEqual([1]);
    expect((await all()).length).toBe(4);
  });

  it("reads everything when it can't push a condition down, rather than guessing", async () => {
    // :isset asks about a request body, which a read has none of.
    const node = compiled("name:isset = true");
    expect(narrowingWhere(node, authorColumns, { request: { ...request, body: { name: "x" } } })).toBeNull();
  });
});
