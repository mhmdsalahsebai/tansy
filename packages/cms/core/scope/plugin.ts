import {
  AliasNode, AndNode, BinaryOperationNode, ColumnNode, IdentifierNode, InsertQueryNode, OnNode, OperationNodeTransformer, OperatorNode,
  PrimitiveValueListNode, ReferenceNode, TableNode, ValueListNode, ValueNode, ValuesNode, WhereNode,
  type DeleteQueryNode, type JoinNode, type KyselyPlugin, type OperationNode, type PluginTransformQueryArgs, type PluginTransformResultArgs,
  type QueryId, type QueryResult, type RootOperationNode, type SelectQueryNode, type UnknownRow, type UpdateQueryNode,
} from "kysely";
import { sql, type RawBuilder } from "kysely";
import { HttpError } from "../http/errors";
import { currentScope, SCOPE_COLUMN, type ScopeState } from "./context";
import { isRecordTable, scopedTables } from "./registry";

/**
 * The one place row scopes are enforced for record tables. Every query built through
 * Kysely on a scoped table gets `"_scope" = <value>`: plain reads, joins, subqueries, updates
 * and deletes. Inserts get the value as a column. Without a scope value it refuses, so a
 * query someone forgets to scope fails rather than reading another scope's rows.
 *
 * Raw SQL (`sql\`...\``) isn't rewritten. The few raw statements on record tables are listed
 * in tests/unit/scope.test.ts, and each scopes itself or only narrows a scoped query.
 */

export class ScopeError extends HttpError {
  constructor(message: string) {
    super(400, "SCOPE_REQUIRED", message);
  }
}

/** A table in a FROM, JOIN, UPDATE or DELETE, and the name its columns are reached by. */
function tableIn(node: OperationNode): { table: string; ref: string } | null {
  if (TableNode.is(node)) return { table: node.table.identifier.name, ref: node.table.identifier.name };
  if (AliasNode.is(node) && TableNode.is(node.node) && IdentifierNode.is(node.alias)) return { table: node.node.table.identifier.name, ref: node.alias.name };
  return null;
}

const tableName = (node: TableNode) => node.table.identifier.name;

const isScopeColumn = (node: OperationNode) => ColumnNode.is(node) && node.column.name === SCOPE_COLUMN;

class ScopeTransformer extends OperationNodeTransformer {
  constructor(private readonly tables: ReadonlySet<string> | null, private readonly state: ScopeState | undefined) {
    super();
  }

  scopes(table: string) {
    return this.isScoped(table);
  }

  valueFor(table: string) {
    return this.value(table);
  }

  private isScoped(table: string) {
    if (!isRecordTable(table)) return false;
    // Not loaded yet: nothing can tell which record tables are scoped, so none may be read.
    if (this.tables === null) throw new Error(`Record table "${table}" used before the scope registry loaded. Await ensureScopeRegistry() first.`);
    return this.tables.has(table);
  }

  /** The value to scope by, or null across every value. Throws where there is none. */
  private value(table: string): string | null {
    const state = this.state;
    if (state?.kind === "all") return null;
    if (state?.kind === "value" && state.value !== null) return state.value;
    throw new ScopeError(state ? `"${table}" is scoped, and this request has no scope.` : `"${table}" is scoped, and this work runs outside any scope. Wrap it in withScope() or unscoped().`);
  }

  private condition(table: string, ref: string): OperationNode | null {
    const value = this.value(table);
    if (value === null) return null;
    return BinaryOperationNode.create(ReferenceNode.create(ColumnNode.create(SCOPE_COLUMN), TableNode.create(ref)), OperatorNode.create("="), ValueNode.create(value));
  }

  /** Conditions for every scoped table among these. */
  private conditions(nodes: ReadonlyArray<OperationNode>) {
    return nodes.flatMap((node) => {
      const found = tableIn(node);
      if (!found || !this.isScoped(found.table)) return [];
      const condition = this.condition(found.table, found.ref);
      return condition ? [condition] : [];
    });
  }

  private static where(where: WhereNode | undefined, conditions: OperationNode[]): WhereNode | undefined {
    if (!conditions.length) return where;
    const joined = conditions.reduce((left, right) => AndNode.create(left, right));
    return where ? WhereNode.create(AndNode.create(where.where, joined)) : WhereNode.create(joined);
  }

  /** A scoped table joined in is narrowed in its ON, so an outer join still keeps the rows on its other side. */
  private joins<T extends { joins?: ReadonlyArray<JoinNode> }>(node: T): T["joins"] {
    return node.joins?.map((join) => {
      const conditions = this.conditions([join.table]);
      if (!conditions.length) return join;
      const joined = conditions.reduce((left, right) => AndNode.create(left, right));
      return { ...join, on: join.on ? OnNode.create(AndNode.create(join.on.on, joined)) : OnNode.create(joined) };
    });
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    const transformed = super.transformSelectQuery(node, queryId);
    const conditions = this.conditions(transformed.from?.froms ?? []);
    return { ...transformed, where: ScopeTransformer.where(transformed.where, conditions), joins: this.joins(transformed) };
  }

  protected override transformUpdateQuery(node: UpdateQueryNode, queryId?: QueryId): UpdateQueryNode {
    const transformed = super.transformUpdateQuery(node, queryId);
    const targets = [transformed.table, ...(transformed.from?.froms ?? [])].filter((item): item is OperationNode => item !== undefined);
    const conditions = this.conditions(targets);
    const scoped = targets.some((item) => { const found = tableIn(item); return found !== null && this.isScoped(found.table); });
    // A row never moves between scope values. Only a scope change on the whole collection may write the column.
    if (scoped && transformed.updates?.some((update) => isScopeColumn(update.column))) throw new Error(`"${SCOPE_COLUMN}" can't be changed.`);
    return { ...transformed, where: ScopeTransformer.where(transformed.where, conditions), joins: this.joins(transformed) };
  }

  protected override transformDeleteQuery(node: DeleteQueryNode, queryId?: QueryId): DeleteQueryNode {
    const transformed = super.transformDeleteQuery(node, queryId);
    const conditions = this.conditions([...transformed.from.froms, ...(transformed.using?.tables ?? [])]);
    return { ...transformed, where: ScopeTransformer.where(transformed.where, conditions), joins: this.joins(transformed) };
  }

  protected override transformInsertQuery(node: InsertQueryNode, queryId?: QueryId): InsertQueryNode {
    const transformed = super.transformInsertQuery(node, queryId);
    if (!transformed.into || !this.isScoped(tableName(transformed.into))) return transformed;
    const table = tableName(transformed.into);
    const state = this.state;
    if (state?.kind !== "value" || state.value === null) throw new ScopeError(`A record in "${table}" needs a scope to be created in.`);
    if (transformed.columns?.some(isScopeColumn)) throw new Error(`"${SCOPE_COLUMN}" is set by core, never by the caller.`);
    const values = transformed.values;
    if (!values || !ValuesNode.is(values) || !transformed.columns) throw new Error(`Only INSERT ... VALUES can write to the scoped table "${table}".`);
    const value = state.value;
    const rows = values.values.map((row) => PrimitiveValueListNode.is(row)
      ? PrimitiveValueListNode.create([...row.values, value])
      : ValueListNode.create([...row.values, ValueNode.create(value)]));
    return InsertQueryNode.cloneWith(transformed, { columns: [...transformed.columns, ColumnNode.create(SCOPE_COLUMN)], values: ValuesNode.create(rows) });
  }
}

/**
 * For the raw SQL that reads a scoped table: `AND alias."_scope" = value`, nothing when the
 * table isn't scoped or the work is trusted across scopes, and the same refusal as the plugin
 * without a scope.
 */
export function rawScopeCondition(table: string, alias: string): RawBuilder<unknown> {
  const transformer = new ScopeTransformer(scopedTables(), currentScope());
  if (!transformer.scopes(table)) return sql``;
  const value = transformer.valueFor(table);
  return value === null ? sql`` : sql` AND ${sql.ref(`${alias}.${SCOPE_COLUMN}`)} = ${value}`;
}

/** The scope column, for the raw SQL that lists a scoped table's columns. */
export const rawScopeColumn = (table: string, alias: string): RawBuilder<unknown>[] =>
  new ScopeTransformer(scopedTables(), currentScope()).scopes(table) ? [sql.ref(`${alias}.${SCOPE_COLUMN}`)] : [];

export class ScopePlugin implements KyselyPlugin {
  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    const transformer = new ScopeTransformer(scopedTables(), currentScope());
    return transformer.transformNode(node, queryId) as RootOperationNode;
  }

  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result;
  }
}

export const scopePlugin = new ScopePlugin();
