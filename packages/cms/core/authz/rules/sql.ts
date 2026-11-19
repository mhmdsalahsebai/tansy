import type { Database } from "better-sqlite3";
import { sql, type RawBuilder, type SqlBool } from "kysely";
import { decodeColumn, type ColumnType } from "../../fields/define";
import { isPostgres } from "../../../lib/prisma/kind";
import { applyModifier, compare, compiled, compareNodes, evaluateNode, followsRelation, nodeKey, resolve, walk, type Resolved, type RuleContext } from "./evaluate";
import { RuleSyntaxError, type Modifier, type Operand, type Operator, type RuleNode } from "./parser";
import { compilePostgres } from "./postgres";

/**
 * Compiles a rule to a WHERE expression. Values are always bound and column names
 * come only from the collection's own columns, so rule text never reaches the SQL.
 * Each comparison calls rule_compare, which runs the evaluator's own compare():
 * a second SQL version of its coercions could drift and change who can read what.
 * The cost is that rules don't use indexes yet.
 */
export type RuleColumns = ReadonlyMap<string, ColumnType>;

interface ColumnSide {
  kind: ColumnType;
  modifier?: Modifier;
  path: string[];
}

type CompileContext = RuleContext & { record: Record<string, never> };

const DENY = sql<SqlBool>`FALSE`;
/** Marks a bound, JSON-encoded constant, as opposed to a column description. */
const CONSTANT = "";

function bind(operand: Operand, columns: RuleColumns, ctx: CompileContext) {
  const kind = operand.kind === "identifier" ? columns.get(operand.path[0]) : undefined;
  if (operand.kind === "identifier" && kind) {
    const [column, ...path] = operand.path;
    const side: ColumnSide = { kind, modifier: operand.modifier, path };
    return { descriptor: JSON.stringify(side), value: sql.id(column) };
  }
  return { descriptor: CONSTANT, value: JSON.stringify(resolve(operand, ctx).value) ?? null };
}

/**
 * Which records a relation-following comparison such as `author.name = "x"` lets
 * through, by `nodeKey`. Resolved against the target collection before the query runs
 * (core/content/relations.ts), because nothing here can read another table.
 */
export type RuleRelations = ReadonlyMap<string, RawBuilder<SqlBool>>;

const NO_RELATIONS: RuleRelations = new Map();

/** The two halves of a resolved relation path: SQL for the query, and the same answer per row for conditions SQL can't carry. */
export interface RelationConditions {
  where: RuleRelations;
  holds: ReadonlyMap<string, (record: Record<string, unknown>) => boolean>;
}

/** A relation path with nothing resolved for it can't be answered, so the rule it is in matches nothing. */
function relationWhere(node: Extract<RuleNode, { type: "compare" }>, columns: RuleColumns, relations: RuleRelations) {
  const prepared = relations.get(nodeKey(node));
  if (prepared) return prepared;
  if (followsRelation(node, columns)) throw new RuleSyntaxError("This comparison follows a relation that was not resolved.");
  return null;
}

function compileNode(node: RuleNode, columns: RuleColumns, ctx: CompileContext, relations: RuleRelations): RawBuilder<SqlBool> {
  if (node.type !== "compare") {
    const left = compileNode(node.left, columns, ctx, relations);
    const right = compileNode(node.right, columns, ctx, relations);
    return node.type === "and" ? sql<SqlBool>`(${left} AND ${right})` : sql<SqlBool>`(${left} OR ${right})`;
  }
  const resolved = relationWhere(node, columns, relations);
  if (resolved) return resolved;
  const left = bind(node.left, columns, ctx);
  const right = bind(node.right, columns, ctx);
  return sql<SqlBool>`rule_compare(${node.op}, ${left.descriptor}, ${left.value}, ${right.descriptor}, ${right.value})`;
}

/** Fails closed, like evaluateRule: a rule that can't be compiled matches nothing. */
export function compileRule(source: string, columns: RuleColumns, ctx: Omit<RuleContext, "record">, relations: RuleRelations = NO_RELATIONS): RawBuilder<SqlBool> {
  try {
    // :changed compares the body with each row, and reads have no body to compare.
    if (Object.keys(ctx.request.body).length) throw new RuleSyntaxError("Compiled rules cannot use a request body.");
    return compileNode(compiled(source), columns, { ...ctx, record: {} }, relations);
  } catch (error) {
    console.error("[rules] compilation failed; denying", error);
    return DENY;
  }
}

/** What a list rule or filter needs: SQL for the database, and any conditions left for the evaluator to check row by row. */
export interface RuleFilter {
  where: RawBuilder<SqlBool>;
  residual: Array<{ node: RuleNode; ctx: Omit<RuleContext, "record">; columns: RuleColumns }>;
}

export const ALLOW_ALL: RuleFilter = { where: sql<SqlBool>`TRUE`, residual: [] };
export const DENY_ALL: RuleFilter = { where: sql<SqlBool>`FALSE`, residual: [] };

export const bothFilters = (a: RuleFilter, b: RuleFilter): RuleFilter => ({ where: sql<SqlBool>`(${a.where} AND ${b.where})`, residual: [...a.residual, ...b.residual] });

/**
 * Sound SQL for one condition, for narrowing a read rather than deciding it: every row it
 * excludes is a row the evaluator would have rejected too, so what comes back still has to go
 * through the evaluator, and the answer can't drift from what a rule or filter means. Null when
 * nothing can be pushed down, which only costs rows read.
 *
 * On SQLite this is the same `rule_compare` call a compiled rule uses, so it is exact, though it
 * reads every row. On Postgres only the conditions that provably match the evaluator become SQL,
 * and a condition that doesn't pushes nothing rather than guessing.
 */
export function narrowingWhere(node: RuleNode, columns: RuleColumns, ctx: Omit<RuleContext, "record">): RawBuilder<SqlBool> | null {
  try {
    // :changed compares against a request body, which a read doesn't have.
    if (Object.keys(ctx.request.body).length) return null;
    if (!isPostgres()) return compileNode(node, columns, { ...ctx, record: {} }, NO_RELATIONS);
    const { where, residual } = compilePostgres(node, columns, { ...ctx, now: ctx.now ?? new Date(), record: {} });
    // Nothing pushed down means `where` is TRUE, which would narrow nothing.
    return residual.length ? null : where;
  } catch (error) {
    // Narrowing is an optimisation: failing to build one is not a failure to answer.
    console.error("[rules] could not narrow a read; reading without it", error);
    return null;
  }
}

/**
 * A condition the evaluator is left to check must be one it can answer. A relation path
 * is answerable only through `ctx.relations`, so without it the whole rule is denied
 * rather than left to compare a value the record doesn't have.
 */
function assertEvaluable(node: RuleNode, columns: RuleColumns, ctx: Omit<RuleContext, "record">) {
  for (const compare of compareNodes(node)) {
    if (followsRelation(compare, columns) && !ctx.relations?.get(nodeKey(compare))) {
      throw new RuleSyntaxError("This comparison follows a relation that was not resolved.");
    }
  }
}

/** Fails closed, like compileRule. `pushdown` is off for views, whose computed columns have types only the database knows. */
export function compileRuleFilter(source: string, columns: RuleColumns, ctx: Omit<RuleContext, "record">, pushdown = true, relations: RuleRelations = NO_RELATIONS): RuleFilter {
  if (!isPostgres()) return { where: compileRule(source, columns, ctx, relations), residual: [] };
  try {
    if (Object.keys(ctx.request.body).length) throw new RuleSyntaxError("Compiled rules cannot use a request body.");
    const now = ctx.now ?? new Date();
    const fixed = { ...ctx, now };
    const node = compiled(source);
    if (!pushdown) {
      assertEvaluable(node, columns, fixed);
      return { where: sql<SqlBool>`TRUE`, residual: [{ node, ctx: fixed, columns }] };
    }
    const { where, residual } = compilePostgres(node, columns, { ...fixed, record: {} }, relations);
    residual.forEach((part) => assertEvaluable(part, columns, fixed));
    return { where, residual: residual.map((part) => ({ node: part, ctx: fixed, columns })) };
  } catch (error) {
    console.error("[rules] compilation failed; denying", error);
    return DENY_ALL;
  }
}

/** Whether a row passes what SQL couldn't check. Any problem denies, as evaluateRule does. */
export function passesResidual(filter: RuleFilter, row: Record<string, unknown>): boolean {
  return filter.residual.every(({ node, ctx, columns }) => {
    try {
      const record = Object.fromEntries([...columns].filter(([name]) => name in row).map(([name, kind]) => [name, decodeColumn(kind, row[name])]));
      return evaluateNode(node, { ...ctx, record });
    } catch (error) {
      console.error("[rules] evaluation failed; denying", error);
      return false;
    }
  });
}

const sides = new Map<string, ColumnSide>();

function columnSide(descriptor: string): ColumnSide {
  let side = sides.get(descriptor);
  if (!side) {
    side = JSON.parse(descriptor) as ColumnSide;
    if (sides.size >= 1000) sides.clear();
    sides.set(descriptor, side);
  }
  return side;
}

function resolveSide(descriptor: string, raw: unknown): Resolved {
  if (descriptor === CONSTANT) return { value: raw === null ? undefined : JSON.parse(raw as string) };
  const { kind, modifier, path } = columnSide(descriptor);
  return applyModifier(modifier, walk({ column: decodeColumn(kind, raw) }, ["column", ...path]));
}

/** Call once on every connection that runs compiled rules. */
export function registerRuleFunctions(database: Database) {
  database.function("rule_compare", (op: Operator, leftSide: string, left: unknown, rightSide: string, right: unknown) =>
    compare(op, resolveSide(leftSide, left), resolveSide(rightSide, right)) ? 1 : 0,
  );
}
