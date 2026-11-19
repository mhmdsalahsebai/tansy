import "server-only";
import { sql, type RawBuilder, type SqlBool } from "kysely";
import { decideRecord, matchesCondition, narrowingFor, type RuleRequest } from "../authz/records";
import type { Principal } from "../authz/principal";
import { collectionSlug, compareNodes, compiled, nodeKey } from "../authz/rules/evaluate";
import type { Operand, RuleNode } from "../authz/rules/parser";
import type { RelationConditions } from "../authz/rules/sql";
import { fieldStorage } from "../fields/registry";
import { HttpError } from "../http/errors";
import type { CollectionWithFields } from "./access";
import { listContains, recordColumns, scanRecords } from "./content-service";
import { flattenRecord, readableFields, type RecordRow } from "./records";

const storageOf = fieldStorage;

/** Columns a caller may filter and sort on. Rules still read every column. */
export function readableColumns(collection: CollectionWithFields, principal: Principal) {
  const readable = new Set(readableFields(collection, principal).map((field) => field.name));
  const hidden = new Set(collection.fields.map((field) => field.name).filter((name) => !readable.has(name)));
  return new Map([...recordColumns(collection)].filter(([name]) => !hidden.has(name)));
}

export const linkedIds = (value: unknown) => ([value].flat() as unknown[]).filter((id): id is number => typeof id === "number");

export interface Relation {
  reverse: boolean;
  target: CollectionWithFields;
  column: string;
  multiple: boolean;
}

/** Where a relation is followed from, and by whom. */
export interface RelationScope {
  principal: Principal;
  collections: CollectionWithFields[];
}

/** A reference field by name, or "<slug>_via_<field>" for records pointing here. Hidden fields can't be followed. */
export function resolveRelation(collection: CollectionWithFields, segment: string, { principal, collections }: RelationScope): Relation {
  const forward = readableFields(collection, principal).find((field) => field.name === segment && storageOf(field).references);
  const forwardTarget = forward && collections.find((c) => c.id === storageOf(forward).references);
  if (forward && forwardTarget) return { reverse: false, target: forwardTarget, column: forward.name, multiple: storageOf(forward).sql === "json" };

  const via = segment.indexOf("_via_");
  if (via > 0) {
    // The slug as it is, or written with underscores for its hyphens, as @collection takes it.
    const written = segment.slice(0, via);
    const source = collections.find((c) => c.slug === written || c.slug === collectionSlug(written));
    const name = segment.slice(via + "_via_".length);
    const field = source && readableFields(source, principal).find((f) => f.name === name && storageOf(f).references === collection.id);
    if (source && field) return { reverse: true, target: source, column: field.name, multiple: storageOf(field).sql === "json" };
  }
  throw new HttpError(400, "INVALID_EXPAND", `Cannot expand "${segment}".`);
}

const relationFor = (collection: CollectionWithFields, segment: string, scope: RelationScope): Relation | null => {
  try {
    return resolveRelation(collection, segment, scope);
  } catch {
    return null;
  }
};

/** Each identifier in a filter that leaves the record, as in `author.name`. */
export function* filterPaths(filter: string) {
  let parsed: RuleNode;
  try {
    parsed = compiled(filter);
  } catch {
    // validateFilter reports the syntax error; there is nothing to follow.
    return;
  }
  for (const node of compareNodes(parsed)) {
    for (const operand of [node.left, node.right]) {
      if (operand.kind === "identifier" && operand.path.length > 1 && !operand.path[0].startsWith("@")) yield { node, operand };
    }
  }
}

/**
 * The relations this filter names, each with the target fields the caller may filter on.
 * Only the segments the filter actually uses are looked up, because a reverse relation's
 * name exists for every collection that points here.
 */
export function relationCatalog(collection: CollectionWithFields, filter: string, scope: RelationScope): ReadonlyMap<string, ReadonlySet<string>> {
  const found = new Map<string, ReadonlySet<string>>();
  for (const { operand } of filterPaths(filter)) {
    const segment = operand.path[0];
    if (found.has(segment)) continue;
    const relation = relationFor(collection, segment, scope);
    if (relation) found.set(segment, new Set(readableColumns(relation.target, scope.principal).keys()));
  }
  return found;
}

/**
 * How many records of a target collection one relation path is answered against, after SQL has
 * narrowed them to the ones that could match. Truncating would change what matches, so more denies.
 */
const MAX_RELATION_ROWS = 10_000;

type Compare = Extract<RuleNode, { type: "compare" }>;
type Identifier = Extract<Operand, { kind: "identifier" }>;

/**
 * Why this comparison can't follow the relation it names. Each limit is here because
 * answering it any other way would mean guessing, or reading past the target's own rules.
 */
function followProblem(node: Compare, operand: Identifier, other: Operand, relation: Relation, principal: Principal): string | null {
  const [segment, field] = operand.path;
  if (relation.target.type === "view") return `"${segment}" points at a view collection, which a filter can't follow.`;
  if (other.kind === "identifier" && !other.path[0].startsWith("@")) return `"${segment}.${field}" can only be compared with a value.`;
  if (operand.path.length > 2) {
    const next = readableFields(relation.target, principal).find((candidate) => candidate.name === field);
    if (next && storageOf(next).references) return `A filter follows one relation at a time, so "${operand.path.join(".")}" is too deep.`;
  }
  // Several records can match, and the evaluator's plain operators ask every value to match. Only the "any" form has an answer here.
  if ((relation.multiple || relation.reverse) && !node.op.startsWith("?")) {
    return `"${segment}" can hold several records, so compare it with ?${node.op} rather than ${node.op}.`;
  }
  return null;
}

const tooBroad = (slug: string) =>
  new HttpError(400, "FILTER_TOO_BROAD", `Too many records of "${slug}" match this filter to follow the relation. Narrow it, or filter on the relation's own column instead, as in its id.`);

/**
 * Answers every relation-following comparison in a filter before the query runs.
 *
 * The target collection is read, every row is put through its own view rule with
 * decideRecord — the same check expand applies — and the comparison itself is answered by
 * the evaluator, so it means exactly what it would on a record of that collection, on
 * either database. What comes back is a condition on this collection's own rows, built
 * from the ids that matched, so a filter can't probe a record the caller may not view:
 * a row the view rule refuses is simply not among them.
 *
 * Read at one moment, like @collection lookups, and capped the same way: a target with
 * more records than the cap denies rather than answering from part of the table.
 */
export async function resolveRelationFilters(
  collection: CollectionWithFields,
  filter: string,
  scope: RelationScope,
  request: RuleRequest,
): Promise<RelationConditions> {
  const where = new Map<string, RawBuilder<SqlBool>>();
  const holds = new Map<string, (record: Record<string, unknown>) => boolean>();
  const { principal } = scope;

  for (const { node, operand } of filterPaths(filter)) {
    const key = nodeKey(node);
    if (where.has(key)) continue;
    const relation = relationFor(collection, operand.path[0], scope);
    if (!relation) continue;
    const other = operand === node.left ? node.right : node.left;
    if (other.kind === "identifier" && other.path.length > 1 && relationFor(collection, other.path[0], scope)) {
      throw new HttpError(400, "INVALID_FILTER", "Two relations can't be compared with each other.");
    }
    const problem = followProblem(node, operand, other, relation, principal);
    if (problem) throw new HttpError(400, "INVALID_FILTER", problem);

    // The same comparison, as it reads on a record of the target collection.
    const inner: Compare = { ...node, [operand === node.left ? "left" : "right"]: { ...operand, path: operand.path.slice(1) } } as Compare;

    // SQL narrows the target to the rows that could match, so only those are read and judged.
    // It can only exclude rows the evaluator would reject, so the answer below is the same
    // either way: without it, this reads the whole collection and the cap is on its size.
    const narrowing = narrowingFor(principal, inner, recordColumns(relation.target), request);
    const rows = await scanRecords(relation.target, MAX_RELATION_ROWS, narrowing ?? undefined);
    if (rows.length > MAX_RELATION_ROWS) throw tooBroad(relation.target.slug);
    const matched = rows.filter((row) => {
      const values = flattenRecord(row);
      return decideRecord(principal, relation.target, "view", values, request) === "allow" && matchesCondition(principal, inner, values, request);
    });

    const [condition, answer] = relation.reverse ? reverseMatch(matched, relation) : forwardMatch(matched, relation);
    where.set(key, condition);
    holds.set(key, answer);
  }
  return { where, holds };
}

type Match = [RawBuilder<SqlBool>, (record: Record<string, unknown>) => boolean];

const FALSE = sql<SqlBool>`FALSE`;

/** The records whose reference column points at one of the matching target records. */
function forwardMatch(matched: RecordRow[], relation: Relation): Match {
  const ids = matched.map((row) => row.id);
  const allowed = new Set(ids);
  if (!ids.length) return [FALSE, () => false];
  if (relation.multiple) {
    return [listContains(relation.column, ids), (record) => linkedIds(record[relation.column]).some((id) => allowed.has(id))];
  }
  return [
    sql<SqlBool>`${sql.ref(relation.column)} IN (${sql.join(ids)})`,
    (record) => typeof record[relation.column] === "number" && allowed.has(record[relation.column] as number),
  ];
}

/** The records the matching source records point back at. */
function reverseMatch(matched: RecordRow[], relation: Relation): Match {
  const ids = new Set(matched.flatMap((row) => linkedIds(row[relation.column])));
  if (ids.size > MAX_RELATION_ROWS) throw tooBroad(relation.target.slug);
  if (!ids.size) return [FALSE, () => false];
  return [sql<SqlBool>`"id" IN (${sql.join([...ids])})`, (record) => typeof record.id === "number" && ids.has(record.id)];
}
