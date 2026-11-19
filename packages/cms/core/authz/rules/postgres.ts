import { sql, type RawBuilder, type SqlBool } from "kysely";
import type { ColumnType } from "../../fields/define";
import { compare, compareValues, followsRelation, isDateLike, nodeKey, normalizeValue, resolve, type RuleContext } from "./evaluate";
import { RuleSyntaxError, type Operand, type Operator, type RuleNode } from "./parser";

type Where = RawBuilder<SqlBool>;
type Columns = ReadonlyMap<string, ColumnType>;
/** Relation-following comparisons already resolved to a condition on this collection's own rows, by nodeKey. */
type Relations = ReadonlyMap<string, Where>;
type Base = "=" | "!=" | ">" | ">=" | "<" | "<=";

const TRUE = sql<SqlBool>`TRUE`;
const FALSE = sql<SqlBool>`FALSE`;

/** More values than this runs in the evaluator, instead of one very long WHERE. */
const MAX_CONSTANTS = 500;

/** Below the surrogate range, UTF-8 byte order (COLLATE "C") and JavaScript's string order agree. */
const ORDERS_LIKE_JAVASCRIPT = /^[\u0001-퟿]*$/;

const FLIP: Record<Base, Base> = { "=": "=", "!=": "!=", ">": "<", ">=": "<=", "<": ">", "<=": ">=" };

const storable = (text: string) => text.isWellFormed() && !text.includes("\u0000");

/**
 * The SQL for one comparison against a non-null column value. Every branch is
 * derived from compareOne in evaluate.ts. Returns true or false when the outcome
 * doesn't depend on the row, and null when SQL can't match the evaluator exactly.
 */
function comparison(kind: ColumnType, column: Where, op: Base, value: unknown): Where | boolean | null {
  if (typeof value === "object") return null;
  const equality = op === "=" || op === "!=";
  const never = op === "!=";
  const operator = sql.raw(op === "!=" ? "<>" : op);

  switch (kind) {
    case "integer":
    case "real": {
      if (equality && typeof value === "boolean") return never;
      const number = Number(value);
      if (Number.isNaN(number)) return equality ? never : null;
      if (!Number.isFinite(number)) return null;
      return sql<SqlBool>`${column} ${operator} ${number}::double precision`;
    }
    case "boolean": {
      if (!equality) return null;
      if (value === true || value === "true") return sql<SqlBool>`${column} ${operator} TRUE`;
      if (value === false || value === "false") return sql<SqlBool>`${column} ${operator} FALSE`;
      return never;
    }
    case "text": {
      if (equality && typeof value === "boolean") return sql<SqlBool>`${column} ${operator} ${String(value)}::text`;
      if (typeof value !== "string" || isDateLike(value)) return null;
      if (equality) return storable(value) ? sql<SqlBool>`${column} ${operator} ${value}::text` : null;
      return ORDERS_LIKE_JAVASCRIPT.test(value) ? sql<SqlBool>`${column} COLLATE "C" ${operator} ${value}::text` : null;
    }
    case "date":
    case "datetime": {
      const time = typeof value === "string" && isDateLike(value) ? Date.parse(value.replace(" ", "T")) : NaN;
      // A stored date never equals text that isn't a date, and ordering against one compares as strings.
      if (Number.isNaN(time)) return equality ? never : null;
      const moment = new Date(time).toISOString();
      const stored = kind === "date" ? sql<SqlBool>`(${column}::timestamp AT TIME ZONE 'UTC')` : column;
      return sql<SqlBool>`${stored} ${operator} ${moment}::timestamptz`;
    }
    default:
      return null;
  }
}

/** A NULL column compares as the empty string, which the evaluator answers once for the whole query. */
function nullAware(column: Where, whenNull: boolean, result: Where | boolean): Where {
  if (typeof result === "boolean") {
    if (result === whenNull) return result ? TRUE : FALSE;
    return result ? sql<SqlBool>`${column} IS NOT NULL` : sql<SqlBool>`${column} IS NULL`;
  }
  return whenNull ? sql<SqlBool>`(${column} IS NULL OR ${result})` : result;
}

function compileComparison(node: Extract<RuleNode, { type: "compare" }>, columns: Columns, ctx: RuleContext): Where | null {
  const isColumn = (operand: Operand) => operand.kind === "identifier" && columns.has(operand.path[0]);
  const [leftColumn, rightColumn] = [isColumn(node.left), isColumn(node.right)];
  if (!leftColumn && !rightColumn) return compare(node.op, resolve(node.left, ctx), resolve(node.right, ctx)) ? TRUE : FALSE;
  if (leftColumn && rightColumn) return null;

  const own = (leftColumn ? node.left : node.right) as Extract<Operand, { kind: "identifier" }>;
  const kind = columns.get(own.path[0])!;
  if (own.path.length > 1 || own.modifier || kind === "json") return null;

  const op: Operator = node.op;
  const any = op.startsWith("?");
  const base = (any ? op.slice(1) : op) as Base | "~" | "!~";
  if (base === "~" || base === "!~") return null;

  const constant = resolve(leftColumn ? node.right : node.left, ctx).value;
  const values = Array.isArray(constant) ? (constant.length ? constant : [""]) : [constant];
  if (values.length > MAX_CONSTANTS) return null;

  const column = sql<SqlBool>`${sql.id(own.path[0])}`;
  const parts: Where[] = [];
  for (const raw of values) {
    const value = normalizeValue(raw);
    const whenNull = leftColumn ? compareValues(base, null, value) : compareValues(base, value, null);
    const result = comparison(kind, column, leftColumn ? base : FLIP[base], value);
    if (result === null) return null;
    parts.push(nullAware(column, whenNull, result));
  }
  // compare() tests each left value against any right value, so a constant on the left of a plain operator must hold for all.
  const separator = !leftColumn && !any ? sql.raw(" AND ") : sql.raw(" OR ");
  return sql<SqlBool>`(${sql.join(parts, separator)})`;
}

function compileNode(node: RuleNode, columns: Columns, ctx: RuleContext, relations: Relations): Where | null {
  if (node.type === "compare") {
    const prepared = relations.get(nodeKey(node));
    if (prepared) return prepared;
    // Left to compileComparison, a relation path would compare a value the record doesn't have.
    if (followsRelation(node, columns)) throw new RuleSyntaxError("This comparison follows a relation that was not resolved.");
    return compileComparison(node, columns, ctx);
  }
  const left = compileNode(node.left, columns, ctx, relations);
  const right = compileNode(node.right, columns, ctx, relations);
  if (!left || !right) return null;
  return sql<SqlBool>`(${left} ${sql.raw(node.type === "and" ? "AND" : "OR")} ${right})`;
}

const conjuncts = (node: RuleNode): RuleNode[] => (node.type === "and" ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node]);

/**
 * Splits a rule into SQL that matches the evaluator exactly, and the conditions
 * that don't translate. Those stay with the evaluator, on the rows the SQL lets
 * through, so there is only ever one definition of what a rule means.
 */
export function compilePostgres(rule: RuleNode, columns: Columns, ctx: RuleContext, relations: Relations = new Map()): { where: Where; residual: RuleNode[] } {
  const pushed: Where[] = [];
  const residual: RuleNode[] = [];
  for (const part of conjuncts(rule)) {
    const where = compileNode(part, columns, ctx, relations);
    if (where) pushed.push(where);
    else residual.push(part);
  }
  return { where: pushed.length ? sql<SqlBool>`(${sql.join(pushed, sql.raw(" AND "))})` : TRUE, residual };
}
