import "server-only";
import type { BetterAuthOptions } from "better-auth";
import { createAdapterFactory, type DBAdapter, type JoinOption, type Where } from "better-auth/adapters";
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from "kysely";
import { requireCollectionBySlug } from "../content/access";
import { encode } from "../content/content-service";
import { recordsDb } from "../content/db";
import { decodeColumn, type ColumnType } from "../fields/define";
import { fieldStorage } from "../fields/registry";
import { tableName } from "../schema/names";
import type { RecordsApi } from "../extend/define";
import { isPostgres } from "../../lib/prisma/kind";
import { AUTH_ID, ROW_ID, type PluginModel } from "./plugin-models";

/**
 * The database better-auth sees. Core models go to Prisma, as before. Models a CMS
 * plugin's better-auth plugins declare are records in that plugin's collections
 * (plugin-models.ts), and their columns on core models, such as user.stripeCustomerId,
 * are records keyed by the core row's id. Writes go through the plugin's system
 * records API, so they're validated, audited under the plugin's name, and fire hooks.
 */

type Row = Record<string, unknown>;
type Tables = Record<string, Record<string, unknown>>;
interface Clause { field: string; operator: string; value: unknown; connector: "AND" | "OR"; mode: "sensitive" | "insensitive" }

const unsupported = (what: string) => new Error(`[tansy] better-auth plugin models: ${what} isn't supported.`);

const clean = (where: Where[] = []): Clause[] =>
  where.map((w) => ({ field: w.field, operator: w.operator ?? "eq", value: w.value, connector: w.connector ?? "AND", mode: w.mode ?? "sensitive" }));

/** Dates as the ISO text records store, and nothing undefined. */
function storable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(storable);
  return value;
}

/** One plugin model's records, read in SQL and written through the system records API. */
export class PluginStore {
  readonly key: string;

  constructor(readonly plan: PluginModel, private readonly records: () => Promise<RecordsApi>) {
    this.key = plan.kind === "model" ? AUTH_ID : ROW_ID;
  }

  /** The collection field for a better-auth field. `id` is better-auth's id for a model, and the core row's id for added fields. */
  column(field: string) {
    if (field === "id") return this.key;
    const column = this.plan.fields.find((candidate) => candidate.name === field)?.column;
    if (!column) throw unsupported(`the field "${this.plan.model}.${field}"`);
    return column;
  }

  has(field: string) {
    return this.plan.fields.some((candidate) => candidate.name === field);
  }

  private async kinds() {
    const collection = await requireCollectionBySlug(this.plan.slug);
    return new Map(collection.fields.map((field) => [field.name, fieldStorage(field).sql]));
  }

  private kindOf(kinds: Map<string, ColumnType>, column: string) {
    const kind = kinds.get(column);
    if (!kind) throw new Error(`The "${this.plan.slug}" collection has no "${column}" field, which the ${this.plan.plugin} plugin needs. Add it back as it was.`);
    return kind;
  }

  private condition(eb: ExpressionBuilder<Tables, string>, kinds: Map<string, ColumnType>, clause: Clause): Expression<SqlBool> {
    const column = this.column(clause.field);
    const kind = this.kindOf(kinds, column);
    const ref = sql.ref(column);
    const insensitive = clause.mode === "insensitive" && typeof clause.value === "string";
    const left = insensitive ? sql`lower(${ref})` : ref;
    const value = (input: unknown) => {
      const stored = encode(kind, storable(input) ?? null);
      return insensitive && typeof stored === "string" ? stored.toLowerCase() : stored;
    };
    switch (clause.operator) {
      case "eq": return clause.value === null ? sql<SqlBool>`${ref} is null` : sql<SqlBool>`${left} = ${value(clause.value)}`;
      case "ne": return clause.value === null ? sql<SqlBool>`${ref} is not null` : sql<SqlBool>`(${left} <> ${value(clause.value)} or ${ref} is null)`;
      case "lt": return sql<SqlBool>`${left} < ${value(clause.value)}`;
      case "lte": return sql<SqlBool>`${left} <= ${value(clause.value)}`;
      case "gt": return sql<SqlBool>`${left} > ${value(clause.value)}`;
      case "gte": return sql<SqlBool>`${left} >= ${value(clause.value)}`;
      case "in":
      case "not_in": {
        const list = Array.isArray(clause.value) ? clause.value.map(value) : [value(clause.value)];
        if (!list.length) return clause.operator === "in" ? sql<SqlBool>`1 = 0` : sql<SqlBool>`1 = 1`;
        const joined = sql.join(list);
        return clause.operator === "in" ? sql<SqlBool>`${left} in (${joined})` : sql<SqlBool>`(${left} not in (${joined}) or ${ref} is null)`;
      }
      // Plain string functions, not LIKE, which treats % and _ as wildcards and ignores case on SQLite.
      case "contains": return isPostgres() ? sql<SqlBool>`strpos(${left}, ${value(clause.value)}) > 0` : sql<SqlBool>`instr(${left}, ${value(clause.value)}) > 0`;
      case "starts_with": return sql<SqlBool>`substr(${left}, 1, length(${value(clause.value)})) = ${value(clause.value)}`;
      case "ends_with": return isPostgres()
        ? sql<SqlBool>`right(${left}, length(${value(clause.value)})) = ${value(clause.value)}`
        : sql<SqlBool>`substr(${left}, -length(${value(clause.value)})) = ${value(clause.value)}`;
      default: throw unsupported(`the "${clause.operator}" operator`);
    }
  }

  /** better-auth's rule: every AND clause, and at least one OR clause when there are any. */
  private whereOf(eb: ExpressionBuilder<Tables, string>, kinds: Map<string, ColumnType>, where: Clause[]) {
    const all = where.filter((clause) => clause.connector === "AND").map((clause) => this.condition(eb, kinds, clause));
    const any = where.filter((clause) => clause.connector === "OR").map((clause) => this.condition(eb, kinds, clause));
    return eb.and(any.length ? [...all, eb.or(any)] : all);
  }

  private toValues(kinds: Map<string, ColumnType>, row: Row): Row {
    const values: Row = { id: row[this.key] };
    for (const field of this.plan.fields) {
      if (field.column in row) values[field.name] = decodeColumn(this.kindOf(kinds, field.column), row[field.column]);
    }
    return values;
  }

  async find(where: Where[] | Clause[] = [], options: { limit?: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } } = {}) {
    const kinds = await this.kinds();
    const clauses = clean(where as Where[]);
    let query = recordsDb.selectFrom(tableName(this.plan.slug)).selectAll();
    if (clauses.length) query = query.where((eb) => this.whereOf(eb, kinds, clauses));
    query = options.sortBy ? query.orderBy(this.column(options.sortBy.field), options.sortBy.direction) : query.orderBy("id", "asc");
    // SQLite has no OFFSET without LIMIT.
    if (options.limit !== undefined || options.offset) query = query.limit(options.limit ?? 1_000_000_000);
    if (options.offset) query = query.offset(options.offset);
    const rows = await query.execute();
    return rows.map((row) => ({ recordId: row.id as number, values: this.toValues(kinds, row) }));
  }

  async count(where: Where[] = []) {
    const kinds = await this.kinds();
    const clauses = clean(where);
    let query = recordsDb.selectFrom(tableName(this.plan.slug)).select(sql<number>`count(*)`.as("count"));
    if (clauses.length) query = query.where((eb) => this.whereOf(eb, kinds, clauses));
    return Number((await query.executeTakeFirst())?.count ?? 0);
  }

  private toColumns(values: Row) {
    const columns: Row = {};
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined || field === "id") continue;
      columns[this.column(field)] = storable(value);
    }
    return columns;
  }

  private fromRecord(record: Row): Row {
    const values: Row = { id: record[this.key] };
    for (const field of this.plan.fields) if (field.column in record) values[field.name] = record[field.column];
    return values;
  }

  async create(values: Row, owner?: string) {
    const id = values.id;
    if (typeof id !== "string" || !id) throw new Error(`[tansy] better-auth plugin models: a ${this.plan.model} needs a text id.`);
    const records = await this.records();
    const record = await records.create(this.plan.slug, { status: "published", [this.key]: id, ...this.toColumns(values) }, owner ? { owner } : undefined);
    return this.fromRecord(record);
  }

  async update(recordId: number, values: Row) {
    const columns = this.toColumns(values);
    const records = await this.records();
    return this.fromRecord(Object.keys(columns).length ? await records.update(this.plan.slug, recordId, columns) : await records.get(this.plan.slug, recordId));
  }

  async remove(recordId: number) {
    await (await this.records()).delete(this.plan.slug, recordId);
  }
}

/**
 * Collections for plugin models, behind better-auth's adapter factory, which adds ids, defaults
 * and value conversion. The factory joins by reading the joined model through this adapter too,
 * so a plugin model joined to a core one, such as an organization's member to its user, reads
 * the core row from `core`. Only reads by a plain condition reach it that way.
 */
function collectionAdapter(stores: Map<string, PluginStore>, core: () => DBAdapter) {
  const storeOf = (model: string, modelKey?: string) => {
    const store = stores.get(modelKey ?? model) ?? stores.get(model);
    if (!store) throw unsupported(`the model "${model}"`);
    return store;
  };
  const known = (model: string, modelKey?: string) => stores.has(modelKey ?? model) || stores.has(model);
  const noJoin = (join: unknown) => {
    if (join && Object.keys(join).length) throw unsupported("joining a plugin model");
  };
  return createAdapterFactory({
    config: {
      adapterId: "tansy-collections",
      adapterName: "tansy collections",
      usePlural: false,
      supportsDates: false,
      supportsJSON: true,
      supportsArrays: true,
      supportsBooleans: true,
      supportsNumericIds: false,
      transaction: false,
    },
    adapter: () => ({
      async create({ model, modelKey, data }) {
        return (await storeOf(model, modelKey).create(data)) as never;
      },
      async findOne({ model, modelKey, where, join }) {
        noJoin(join);
        if (!known(model, modelKey)) return core().findOne({ model: modelKey ?? model, where }) as never;
        return ((await storeOf(model, modelKey).find(where, { limit: 1 }))[0]?.values ?? null) as never;
      },
      async findMany({ model, modelKey, where, limit, offset, sortBy, join }) {
        noJoin(join);
        if (!known(model, modelKey)) return core().findMany({ model: modelKey ?? model, where, limit, offset, sortBy }) as never;
        return (await storeOf(model, modelKey).find(where, { limit, offset, sortBy })).map((row) => row.values) as never;
      },
      async count({ model, modelKey, where }) {
        return storeOf(model, modelKey).count(where);
      },
      async update({ model, modelKey, where, update }) {
        const store = storeOf(model, modelKey);
        const [match] = await store.find(where, { limit: 1 });
        return (match ? await store.update(match.recordId, update as Row) : null) as never;
      },
      async updateMany({ model, modelKey, where, update }) {
        const store = storeOf(model, modelKey);
        const matches = await store.find(where);
        for (const match of matches) await store.update(match.recordId, update);
        return matches.length;
      },
      async delete({ model, modelKey, where }) {
        const store = storeOf(model, modelKey);
        const [match] = await store.find(where, { limit: 1 });
        if (match) await store.remove(match.recordId);
      },
      async deleteMany({ model, modelKey, where }) {
        const store = storeOf(model, modelKey);
        const matches = await store.find(where);
        for (const match of matches) await store.remove(match.recordId);
        return matches.length;
      },
    }),
  });
}

type Schema = Record<string, { fields?: Record<string, unknown>; modelName?: string }>;

/** The options Prisma's adapter gets: without the models and fields it has no columns for. */
function withoutPlanned(options: BetterAuthOptions, byName: Map<string, PluginModel>): BetterAuthOptions {
  return {
    ...options,
    plugins: options.plugins?.map((plugin) => {
      if (!plugin.schema) return plugin;
      const schema: Schema = {};
      for (const [model, table] of Object.entries(plugin.schema as Schema)) {
        const plan = byName.get(model);
        if (!plan) schema[model] = table;
        else if (plan.kind === "fields") {
          const fields = Object.fromEntries(Object.entries(table.fields ?? {}).filter(([field]) => !plan.fields.some((planned) => planned.name === field)));
          if (Object.keys(fields).length) schema[model] = { ...table, fields };
        }
      }
      return { ...plugin, schema } as typeof plugin;
    }),
  };
}

/**
 * Wraps the adapter core models use. `recordsFor` gives the system records API of the
 * CMS plugin that owns a model, so its writes are attributed to it.
 */
export function routePluginModels(plans: PluginModel[], recordsFor: (plugin: string) => Promise<RecordsApi>, inner: (options: BetterAuthOptions) => DBAdapter) {
  if (!plans.length) return inner;
  const stores = new Map<string, PluginStore>();
  const byName = new Map<string, PluginModel>();
  for (const plan of plans) {
    const store = new PluginStore(plan, () => recordsFor(plan.plugin));
    for (const name of [plan.model, ...plan.aliases]) {
      stores.set(name, store);
      byName.set(name, plan);
    }
  }

  return (options: BetterAuthOptions): DBAdapter => {
    const core = inner(withoutPlanned(options, byName));
    // Joined core rows come back through the router, so they get the fields plugins add to them.
    const own = collectionAdapter(new Map([...stores].filter(([, store]) => store.plan.kind === "model")), () => router)(options);
    const modelStore = (model: string) => { const store = stores.get(model); return store?.plan.kind === "model" ? store : null; };
    const fieldStore = (model: string) => { const store = stores.get(model); return store?.plan.kind === "fields" ? store : null; };

    const split = (store: PluginStore, data: Row) => {
      const added: Row = {};
      const rest: Row = {};
      for (const [field, value] of Object.entries(data)) (store.has(field) ? added : rest)[field] = value;
      return [rest, added] as const;
    };

    /** A where clause naming added fields becomes one on the core row's id. Null means nothing can match. */
    const coreWhere = async (store: PluginStore, where: Where[] = []): Promise<Where[] | null> => {
      const added = where.filter((clause) => store.has(clause.field));
      if (!added.length) return where;
      if (where.some((clause) => clause.connector === "OR")) throw unsupported(`OR conditions on "${store.plan.model}" fields a plugin adds`);
      const ids = (await store.find(added)).map((row) => row.values.id as string);
      if (!ids.length) return null;
      return [...where.filter((clause) => !store.has(clause.field)), { field: "id", operator: "in", value: ids }];
    };

    const merge = async <T>(store: PluginStore, rows: T[]): Promise<T[]> => {
      const ids = rows.map((row) => (row as Row | null)?.id).filter((id): id is string => typeof id === "string");
      if (!ids.length) return rows;
      const found = new Map((await store.find([{ field: "id", operator: "in", value: ids }])).map((row) => [row.values.id, row.values]));
      return rows.map((row) => {
        if (!row) return row;
        const values = { ...found.get((row as Row).id) };
        delete values.id;
        return { ...Object.fromEntries(store.plan.fields.map((field) => [field.name, null])), ...(row as Row), ...values } as T;
      });
    };

    /** Joined core rows get their added fields too. A join to a plugin model would cross databases. */
    const mergeJoins = async <T>(rows: T[], join?: JoinOption): Promise<T[]> => {
      for (const model of Object.keys(join ?? {})) {
        if (modelStore(model)) throw unsupported("joining a plugin model");
        const store = fieldStore(model);
        if (!store) continue;
        for (const row of rows as Row[]) {
          if (!row?.[model]) continue;
          row[model] = Array.isArray(row[model]) ? await merge(store, row[model] as Row[]) : (await merge(store, [row[model] as Row]))[0];
        }
      }
      return rows;
    };

    const save = async (store: PluginStore, id: string, added: Row) => {
      if (!Object.keys(added).length) return;
      const [existing] = await store.find([{ field: "id", value: id }], { limit: 1 });
      if (existing) await store.update(existing.recordId, added);
      else await store.create({ ...added, id }, store.plan.model === "user" ? id : undefined);
    };

    const coreSelect = (store: PluginStore, select?: string[]) => (select ? [...new Set(["id", ...select.filter((field) => !store.has(field))])] : undefined);

    const router: DBAdapter = {
      ...core,
      async create(input) {
        if (modelStore(input.model)) return own.create(input);
        const store = fieldStore(input.model);
        if (!store) return core.create(input);
        const [rest, added] = split(store, input.data as Row);
        const row = await core.create({ ...input, data: rest as never, select: coreSelect(store, input.select) }) as Row;
        await save(store, row.id as string, added);
        return { ...row, ...added } as never;
      },
      async findOne(input) {
        if (modelStore(input.model)) return own.findOne(input);
        const store = fieldStore(input.model);
        if (!store) return (await mergeJoins([await core.findOne(input)], input.join))[0] as never;
        const where = await coreWhere(store, input.where);
        if (!where) return null;
        const row = await core.findOne({ ...input, where, select: coreSelect(store, input.select) });
        return (await mergeJoins(await merge(store, [row]), input.join))[0] as never;
      },
      async findMany(input) {
        if (modelStore(input.model)) return own.findMany(input);
        const store = fieldStore(input.model);
        if (!store) return mergeJoins(await core.findMany(input), input.join);
        if (input.sortBy && store.has(input.sortBy.field)) throw unsupported(`sorting by "${input.sortBy.field}"`);
        const where = await coreWhere(store, input.where);
        if (!where) return [];
        return mergeJoins(await merge(store, await core.findMany({ ...input, where, select: coreSelect(store, input.select) })), input.join);
      },
      async count(input) {
        if (modelStore(input.model)) return own.count(input);
        const store = fieldStore(input.model);
        if (!store) return core.count(input);
        const where = await coreWhere(store, input.where);
        return where ? core.count({ ...input, where }) : 0;
      },
      async update(input) {
        if (modelStore(input.model)) return own.update(input);
        const store = fieldStore(input.model);
        if (!store) return core.update(input);
        const where = await coreWhere(store, input.where);
        if (!where) return null;
        const [rest, added] = split(store, input.update);
        const row = (Object.keys(rest).length ? await core.update({ ...input, where, update: rest }) : await core.findOne({ model: input.model, where })) as Row | null;
        if (!row) return null;
        await save(store, row.id as string, added);
        return (await merge(store, [row]))[0] as never;
      },
      async updateMany(input) {
        if (modelStore(input.model)) return own.updateMany(input);
        const store = fieldStore(input.model);
        if (!store) return core.updateMany(input);
        const where = await coreWhere(store, input.where);
        if (!where) return 0;
        const [rest, added] = split(store, input.update);
        const rows = await core.findMany<Row>({ model: input.model, where, select: ["id"] });
        if (Object.keys(rest).length) await core.updateMany({ ...input, where, update: rest });
        for (const row of rows) await save(store, row.id as string, added);
        return rows.length;
      },
      async delete(input) {
        if (modelStore(input.model)) return own.delete(input);
        const store = fieldStore(input.model);
        if (!store) return core.delete(input);
        const where = await coreWhere(store, input.where);
        if (!where) return;
        const row = await core.findOne<Row>({ model: input.model, where, select: ["id"] });
        await core.delete({ ...input, where });
        if (row) for (const match of await store.find([{ field: "id", value: row.id as string }])) await store.remove(match.recordId);
      },
      async deleteMany(input) {
        if (modelStore(input.model)) return own.deleteMany(input);
        const store = fieldStore(input.model);
        if (!store) return core.deleteMany(input);
        const where = await coreWhere(store, input.where);
        if (!where) return 0;
        const rows = await core.findMany<Row>({ model: input.model, where, select: ["id"] });
        const count = await core.deleteMany({ ...input, where });
        const ids = rows.map((row) => row.id as string);
        if (ids.length) for (const match of await store.find([{ field: "id", operator: "in", value: ids }])) await store.remove(match.recordId);
        return count;
      },
      async consumeOne(input) {
        if (modelStore(input.model)) return own.consumeOne(input);
        if (fieldStore(input.model)?.plan.fields.length && input.where.some((clause) => fieldStore(input.model)!.has(clause.field))) throw unsupported("consuming by a field a plugin adds");
        return core.consumeOne(input);
      },
      async incrementOne(input) {
        if (modelStore(input.model)) return own.incrementOne(input);
        const store = fieldStore(input.model);
        if (store && [...input.where.map((clause) => clause.field), ...Object.keys(input.increment), ...Object.keys(input.set ?? {})].some((field) => store.has(field))) throw unsupported("incrementing a field a plugin adds");
        return core.incrementOne(input);
      },
      // Core's adapter runs transactions as plain sequences, so this one does too.
      transaction: (callback) => callback(router),
    };
    return router;
  };
}
