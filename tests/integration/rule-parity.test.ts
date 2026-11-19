import { Kysely, PostgresDialect, sql, type RawBuilder, type SqlBool } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { compilePostgres } from "@/core/authz/rules/postgres";
import { evaluateNode, type RuleContext } from "@/core/authz/rules/evaluate";
import type { Operand, Operator, RuleNode } from "@/core/authz/rules/parser";
import type { ColumnType } from "@/core/fields/define";

/**
 * What a rule means is defined by the evaluator. This checks that every condition
 * the Postgres compiler turns into SQL picks exactly the rows the evaluator picks,
 * across values and constants chosen to hit each coercion in compareOne.
 */
const url = inject("databaseUrl");
const postgres = /^postgres(ql)?:/i.test(url);

const VALUES: Record<Exclude<ColumnType, "json">, unknown[]> = {
  text: [null, "", "abc", "ABC", "abd", "5", "5.0", " 5 ", "0", "true", "false", "2024-01-15", "2024-01-15T10:00:00.000Z", "2024-13-45", "é", "😀", "�", "z"],
  integer: [null, 0, 1, 5, -3, 2 ** 40],
  real: [null, 0, 1.5, 5, -0.25, 1e21],
  boolean: [null, true, false],
  date: [null, "2024-01-15", "1999-12-31", "2024-02-29"],
  datetime: [null, "2024-01-15T00:00:00.000Z", "2024-01-15T10:00:00.000Z", "1999-12-31T23:59:59.999Z"],
};

const CONSTANTS: unknown[] = [
  null, "", "abc", "ABC", "abd", "5", "5.0", " 5 ", "0", "true", "false", "nope", 0, 1, 5, 1.5, -3, 2 ** 40, 1e21, true, false,
  "2024-01-15", "2024-01-15T00:00:00.000Z", "2024-01-15T10:00:00.000Z", "2024-01-15 10:00", "2024-13-45", "1999-12-31", "é", "😀", "￾", "a\u0000b", { a: 1 }, [], [null], [1, "abc"], ["5", 5, true],
  new Date("2024-01-15T10:00:00.000Z"),
];

const OPERATORS: Operator[] = ["=", "!=", ">", ">=", "<", "<=", "~", "!~", "?=", "?!=", "?>", "?>=", "?<", "?<=", "?~", "?!~"];
const KINDS = Object.keys(VALUES) as Array<keyof typeof VALUES>;
const COLUMN_SQL = { text: "TEXT", integer: "BIGINT", real: "DOUBLE PRECISION", boolean: "BOOLEAN", date: "DATE", datetime: "TIMESTAMPTZ(3)" };
const columns = new Map<string, ColumnType>(KINDS.map((kind) => [`c_${kind}`, kind]));

const request: RuleContext["request"] = { auth: {}, body: {}, query: {}, headers: {}, method: "GET", context: "default" };
/** The constant travels through the request, as a real value would, so arrays and dates reach the compiler. */
const CONSTANT: Operand = { kind: "identifier", path: ["@request", "query", "constant"] };
const context = (value: unknown): RuleContext => ({ record: {}, request: { ...request, query: { constant: value } }, now: new Date("2024-06-01T00:00:00.000Z") });
const column = (kind: string): Operand => ({ kind: "identifier", path: [`c_${kind}`] });

describe.runIf(postgres)("Postgres rules match the evaluator", () => {
  let db: Kysely<Record<string, Record<string, unknown>>>;
  const rows: Array<{ id: number; kind: string; value: unknown }> = [];

  beforeAll(async () => {
    db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 4 }) }) });
    await sql.raw(`DROP TABLE IF EXISTS parity; CREATE TABLE parity (id INTEGER PRIMARY KEY, ${KINDS.map((kind) => `c_${kind} ${COLUMN_SQL[kind]}`).join(", ")})`).execute(db);
    let id = 0;
    for (const kind of KINDS) {
      for (const value of VALUES[kind]) {
        rows.push({ id: ++id, kind, value });
        await sql`INSERT INTO parity (id, ${sql.ref(`c_${kind}`)}) VALUES (${id}, ${value})`.execute(db);
      }
    }
  });

  afterAll(async () => {
    await sql`DROP TABLE parity`.execute(db);
    await db.destroy();
  });

  const selected = async (where: RawBuilder<SqlBool>, kind: string) =>
    (await sql<{ id: number }>`SELECT id FROM parity WHERE id IN (${sql.join(rows.filter((row) => row.kind === kind).map((row) => row.id))}) AND ${where} ORDER BY id`.execute(db)).rows.map((row) => row.id);

  const expected = (node: RuleNode, kind: string, value: unknown) =>
    rows.filter((row) => row.kind === kind && evaluateNode(node, { ...context(value), record: { [`c_${kind}`]: row.value } })).map((row) => row.id);

  it("for every kind, constant, operator and side", async () => {
    let pushed = 0;
    let checked = 0;
    for (const kind of KINDS) {
      for (const value of CONSTANTS) {
        for (const op of OPERATORS) {
          for (const node of [
            { type: "compare", op, left: column(kind), right: CONSTANT },
            { type: "compare", op, left: CONSTANT, right: column(kind) },
          ] as RuleNode[]) {
            const { where, residual } = compilePostgres(node, columns, context(value));
            checked++;
            if (residual.length) continue;
            pushed++;
            expect(await selected(where, kind), `${kind} ${JSON.stringify(node)} constant ${JSON.stringify(value)}`).toEqual(expected(node, kind, value));
          }
        }
      }
    }
    // Guards against the compiler quietly giving up on everything, which would make this test empty.
    expect(pushed / checked).toBeGreaterThan(0.3);
  }, 300_000);

  it("turns the rules people actually write into SQL", () => {
    const auth = (field: string): Operand => ({ kind: "identifier", path: ["@request", "auth", field] });
    const literal = (value: string | number | boolean): Operand => ({ kind: "literal", value });
    const owned = new Map<string, ColumnType>([...columns, ["status", "text"], ["createdById", "text"], ["createdAt", "datetime"]]);
    const signedIn: RuleContext = { ...context(null), request: { ...request, auth: { id: "user-1" } } };
    const common: RuleNode[] = [
      { type: "compare", op: "=", left: { kind: "identifier", path: ["status"] }, right: literal("published") },
      { type: "compare", op: "=", left: auth("id"), right: { kind: "identifier", path: ["createdById"] } },
      { type: "compare", op: ">=", left: { kind: "identifier", path: ["createdAt"] }, right: { kind: "identifier", path: ["@yesterday"] } },
      { type: "compare", op: ">", left: column("integer"), right: literal(5) },
      { type: "compare", op: "=", left: column("boolean"), right: literal(true) },
      { type: "compare", op: "!=", left: auth("id"), right: literal("") },
    ];
    for (const node of common) expect(compilePostgres(node, owned, signedIn).residual, JSON.stringify(node)).toEqual([]);
  });

  it("keeps untranslatable conditions for the evaluator, without dropping the rest", () => {
    const easy: RuleNode = { type: "compare", op: "=", left: column("integer"), right: { kind: "literal", value: 5 } };
    const hard: RuleNode = { type: "compare", op: "~", left: column("text"), right: { kind: "literal", value: "a" } };
    const and = compilePostgres({ type: "and", left: easy, right: hard }, columns, context(null));
    expect(and.residual).toEqual([hard]);
    const or = compilePostgres({ type: "or", left: easy, right: hard }, columns, context(null));
    expect(or.residual).toHaveLength(1);
    expect(or.residual[0].type).toBe("or");
  });

  it("binds values rather than writing them into the SQL", () => {
    const attack = `' OR 1=1 --`;
    const { where } = compilePostgres({ type: "compare", op: "=", left: column("text"), right: { kind: "literal", value: attack } }, columns, context(null));
    const compiled = where.compile(db);
    expect(compiled.sql).not.toContain("OR 1=1");
    expect(compiled.parameters).toContain(attack);
  });
});
