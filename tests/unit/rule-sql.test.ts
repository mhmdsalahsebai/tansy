import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateRule, type RuleContext } from "@/core/authz/rules/evaluate";
import { compileRule, registerRuleFunctions } from "@/core/authz/rules/sql";
import { decodeColumn, type ColumnType } from "@/core/fields/define";

const columns = new Map<string, ColumnType>([
  ["id", "integer"],
  ["status", "text"],
  ["createdAt", "datetime"],
  ["publishedAt", "datetime"],
  ["createdById", "text"],
  ["title", "text"],
  ["views", "real"],
  ["live", "boolean"],
  ["day", "date"],
  ["tags", "json"],
  ["meta", "json"],
]);

type Row = Record<string, string | number | null>;
const base: Row = { status: "draft", createdAt: "2026-06-01T10:00:00.000Z", publishedAt: null, createdById: null, title: null, views: null, live: null, day: null, tags: null, meta: null };
const overrides: Row[] = [
  {},
  { status: "published", publishedAt: "2026-06-15T01:00:00.000Z", createdById: "u1", title: "Hello World", views: 5, live: 1, day: "2026-06-15", tags: '["a","b"]', meta: '{"owner":"u1","n":{"x":1}}' },
  { status: "published", createdById: "u2", title: "", views: 0, live: 0, tags: "[]", meta: "{}" },
  { title: "2026-06-15", views: -1.5, tags: '["a"]', day: "2026-01-01" },
  { title: "100%_sure", views: 100, tags: '["b","c"]', createdById: "" },
  { title: "HELLO", views: 5.5, tags: "[1,2]", meta: '{"owner":null}' },
  { title: "0", views: 1, createdAt: "2026-06-15T12:00:00.000Z" },
  { title: "true", live: 1, tags: '["true"]' },
];
const rows: Row[] = overrides.map((row, index) => ({ ...base, ...row, id: index + 1 }));

const request: RuleContext["request"] = {
  auth: { id: "u1", role: "member", email: "A@x.io", emailVerified: true },
  body: {},
  query: { q: "a", list: ["a", "z"], empty: [] },
  headers: { x_token: "t" },
  method: "GET",
  context: "default",
};
const now = new Date("2026-06-15T12:00:00Z");

const database = new Database(":memory:");
registerRuleFunctions(database);
const db = new Kysely<Record<string, Row>>({ dialect: new SqliteDialect({ database }) });

const decoded = (row: Row): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decodeColumn(columns.get(key)!, value)])),
  createdById: row.createdById ?? "",
});

const viaSql = async (rule: string, req = request) => {
  const found = await db.selectFrom("rec").select("id").where(compileRule(rule, columns, { request: req, now })).orderBy("id").execute();
  return found.map((row) => row.id);
};
const inMemory = (rule: string, req = request) =>
  rows.filter((row) => evaluateRule(rule, { record: decoded(row), request: req, now })).map((row) => row.id);

beforeAll(async () => {
  database.exec(`CREATE TABLE rec (id INTEGER PRIMARY KEY, status TEXT, createdAt TEXT, publishedAt TEXT, createdById TEXT, title TEXT, views REAL, live INTEGER, day TEXT, tags TEXT, meta TEXT) STRICT`);
  await db.insertInto("rec").values(rows).execute();
});
afterAll(() => db.destroy());

describe("compiled rules match the evaluator", () => {
  const cases = [
    'status = "published"', 'status != "published"', "status = status", "@request.auth.id = createdById", 'createdById = ""', 'createdById != ""',
    'title = ""', 'title != ""', "title = null", "title != null", 'title = "hello world"', 'title = "HELLO"', 'title ~ "hello"', 'title !~ "hello"', 'title ~ "h%d"', 'title ~ "100%"', 'title ~ ""',
    'title:lower = "hello"', "title:length = 1", "title:length = 0", "title = 0", "title > 1", 'title = "2026-06-15T00:00:00Z"',
    "views = 0", "views != 0", "views > 1", "views >= 5", "views < 0", "views <= 5.5", "views = null", 'views = ""', 'views = "5"', 'views > "abc"', "views = id",
    "live = true", "live = false", "live != true", "live = 1", 'live = "true"', "live = null", "@request.auth.emailVerified = live",
    "createdAt > @todayStart", "createdAt <= @now", 'createdAt > "2026-06-01 09:00"', "publishedAt = null", "publishedAt >= @monthStart", "publishedAt < @tomorrow", 'day = "2026-06-15"', "day < @now", "day >= @yearStart",
    'tags = "a"', 'tags ?= "a"', 'tags != "a"', 'tags ?!= "a"', 'tags ~ "a"', 'tags ?~ "c"', "tags:length = 2", "tags:length = 0", "tags = null", 'tags = ""', "tags ?= 1", 'tags ?= "true"', "tags:each ?= @request.query.q",
    "tags ?= @request.query.list", "tags = @request.query.empty", "tags ?= tags", "tags = tags", "views ?> tags",
    'meta = "{}"', "meta != null", 'meta.owner = "u1"', "meta.owner = @request.auth.id", 'meta.owner = ""', "meta.owner = null", "meta.n.x = 1", "meta.n.y = null", "meta.owner:length = 1", 'meta.toString != ""', 'title.length = 5',
    '@request.auth.id != ""', '@request.auth.id = "nobody"', '@request.method = "GET"', '@request.headers.x_token = "t"', '@request.query.q = "a"', '@request.query.q:isset = true', '@request.query.nope:isset = true', "@year = 2026", "@year = 1999",
    '@request.body.title:isset = false', "@request.body.title:changed = false", '@request.body.title = ""',
    '"published" = status', "5 < views", "null = title", 'true = live', "1 = 1", "1 = 2", '"a" ~ title',
    'constructor != ""', "__proto__ = null", 'nosuchfield = ""',
    'status = "published" && views > 1', 'status = "draft" || views > 50', '(status = "published" || views = 100) && title != ""', 'status = "x" || status = "published" && views > 1', '(title = "" || views = 0) && (live = false || tags:length = 0)',
    "this is not a rule", 'status = "published" &&',
  ];
  it.each(cases)("%s", async (rule) => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await viaSql(rule)).toEqual(inMemory(rule));
    quiet.mockRestore();
  });
  it("matches for a signed-out caller", async () => {
    const anonymous = { ...request, auth: { id: "", role: "", email: "" } };
    for (const rule of ['@request.auth.id != ""', "@request.auth.id = createdById", 'status = "published" || @request.auth.id = createdById']) {
      expect(await viaSql(rule, anonymous), rule).toEqual(inMemory(rule, anonymous));
    }
  });
});

describe("compiled rules are safe", () => {
  const quietly = async <T>(run: () => Promise<T>) => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { return await run(); } finally { quiet.mockRestore(); }
  };
  const tableExists = () => database.prepare("SELECT count(*) AS n FROM rec").get() as { n: number };

  it("binds every value and quotes every column", () => {
    const hostile = `x'; DROP TABLE rec; --`;
    const { sql: text, parameters } = compileRule(`title = "${hostile}" || "${hostile}" = status`, columns, { request, now }).compile(db);
    expect(text).not.toContain("DROP");
    expect(text).toContain('"title"');
    expect(parameters).toContain(JSON.stringify(hostile));
  });
  it("treats injection in values and request data as plain text", async () => {
    const hostile = { ...request, query: { q: `' OR 1=1; DROP TABLE rec; --` } };
    expect(await viaSql(`title = "' OR '1'='1"`)).toEqual([]);
    expect(await viaSql("title = @request.query.q", hostile)).toEqual([]);
    expect(tableExists().n).toBe(rows.length);
  });
  it("never turns an unknown name into a column", () => {
    const { sql: text } = compileRule('rowid != "" && sqlite_master = 1 && title = 1', columns, { request, now }).compile(db);
    expect(text).not.toContain("rowid");
    expect(text).not.toContain("sqlite_master");
  });
  it("fails closed", async () => {
    await quietly(async () => {
      expect(await viaSql("this is not a rule")).toEqual([]);
      expect(await viaSql('title = "x" ||')).toEqual([]);
      expect(await viaSql('status != "nope"', { ...request, body: { title: "x" } })).toEqual([]);
    });
  });
  it("is usable as a plain expression", async () => {
    const { n } = (await sql<{ n: number }>`SELECT count(*) AS n FROM rec WHERE ${compileRule('status = "published"', columns, { request, now })}`.execute(db)).rows[0];
    expect(n).toBe(2);
  });
});
