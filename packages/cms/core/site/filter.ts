import { parseRule, type Operand, type RuleNode } from "../authz/rules/parser";
import type { SiteRecord } from "../theme/define";

/** At most this many values from one list field, so a filter stays under the API's length limit. */
const MAX_VALUES = 50;
// What the rule tokenizer reads back as a number. Anything else, such as 1e21, isn't written in.
const NUMBER = /^-?\d+(\.\d+)?$/;
// Compares two constants, so it matches no row. Stands for "any of no values".
const NOTHING: RuleNode = { type: "compare", op: "=", left: { kind: "literal", value: 0 }, right: { kind: "literal", value: 1 } };

type Scalar = string | number | boolean | null;

class Unbindable extends Error {}

const isScalar = (value: unknown): value is Scalar => value === null || ["string", "number", "boolean"].includes(typeof value);

function recordValue(operand: Operand, record: SiteRecord): Scalar | Scalar[] | undefined {
  if (operand.kind !== "identifier" || operand.path[0] !== "@record") return undefined;
  if (operand.path.length !== 2 || operand.modifier) throw new Unbindable("Use @record.<field>, with no modifier.");
  // Absent when the field was removed or is hidden from visitors. Matching it as empty would match the wrong records.
  if (!Object.hasOwn(record, operand.path[1])) throw new Unbindable(`the record has no field "${operand.path[1]}".`);
  const value = record[operand.path[1]];
  if (isScalar(value)) return value;
  if (Array.isArray(value) && value.length <= MAX_VALUES && value.every(isScalar)) return value;
  throw new Unbindable(`@record.${operand.path[1]} isn't a value or a list of values.`);
}

const literal = (value: Scalar): Operand => {
  if (typeof value === "number" && !NUMBER.test(String(value))) throw new Unbindable("A number can't be written into a filter.");
  return { kind: "literal", value };
};

function bindNode(node: RuleNode, record: SiteRecord): RuleNode {
  if (node.type !== "compare") return { type: node.type, left: bindNode(node.left, record), right: bindNode(node.right, record) };
  const left = recordValue(node.left, record);
  const right = recordValue(node.right, record);
  if (Array.isArray(left) && Array.isArray(right)) throw new Unbindable("Only one side of a comparison can be a list from @record.");
  const list = Array.isArray(left) ? "left" : Array.isArray(right) ? "right" : null;
  const side = (operand: Operand, value: Scalar | Scalar[] | undefined) => (value === undefined || Array.isArray(value) ? operand : literal(value));
  const bound: RuleNode = { ...node, left: side(node.left, left), right: side(node.right, right) };
  if (!list) return bound;
  // An "any" comparison against a list is true when it is true for one of the values, which is an OR of each.
  if (!node.op.startsWith("?")) throw new Unbindable(`A list from @record needs an "any" operator, such as ?=.`);
  const values = (list === "left" ? left : right) as Scalar[];
  if (!values.length) return NOTHING;
  return values.map((value): RuleNode => ({ ...bound, [list]: literal(value) })).reduce((all, one) => ({ type: "or", left: all, right: one }));
}

function quote(value: Scalar) {
  if (typeof value !== "string") return String(value);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const operand = (side: Operand) => (side.kind === "literal" ? quote(side.value) : `${side.path.join(".")}${side.modifier ? `:${side.modifier}` : ""}`);

const isRecord = (side: Operand) => side.kind === "identifier" && side.path[0] === "@record";
const mentionsRecord = (node: RuleNode): boolean => (node.type === "compare" ? isRecord(node.left) || isRecord(node.right) : mentionsRecord(node.left) || mentionsRecord(node.right));

const chain = (node: RuleNode, type: "and" | "or"): RuleNode[] => (node.type === type ? [...chain(node.left, type), ...chain(node.right, type)] : [node]);

/** Back to rule text. Chains print flat, so a long OR doesn't count against the parser's nesting limit. */
function print(node: RuleNode, inside: "and" | "or" | null = null): string {
  if (node.type === "compare") return `${operand(node.left)} ${node.op} ${operand(node.right)}`;
  const text = chain(node, node.type).map((part) => print(part, node.type)).join(node.type === "and" ? " && " : " || ");
  return node.type === "or" && inside === "and" ? `(${text})` : text;
}

/**
 * Writes the page's record into a template query's filter, as `@record.<field>`. Values become
 * literals in the rule's own syntax, and the API binds them as parameters as it does any filter.
 * A list field, such as a post's tags, matches when any of its values does: `tags ?= @record.tags`.
 *
 * Returns null when the filter can't be bound: on a page with no record, or for a value
 * that isn't plain, which the template then gets as an empty list.
 */
export function bindRecordFilter(filter: string, record: SiteRecord | null): string | null {
  if (!filter.includes("@record")) return filter;
  const tree = parseRule(filter);
  if (!mentionsRecord(tree)) return filter;
  if (!record) return null;
  try {
    return print(bindNode(tree, record));
  } catch (error) {
    if (error instanceof Unbindable) {
      console.warn(`[site] filter "${filter}": ${error.message}`);
      return null;
    }
    throw error;
  }
}
