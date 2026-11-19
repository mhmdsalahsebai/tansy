import "server-only";
import prisma from "../../lib/prisma";
import { localeTableName, tableName } from "../schema/names";

/**
 * Which record tables are scoped, held in memory so the query plugin can decide synchronously.
 * Until it is loaded, the plugin refuses every record table, so nothing reads one unscoped by
 * starting too early. It lives on globalThis because Next.js can load this module more than
 * once in one process, and every copy must agree.
 */
interface Registry {
  tables: Set<string> | null;
  collections: Set<number>;
  loading: Promise<void> | null;
}

declare const globalThis: { cmsScopeRegistry?: Registry } & typeof global;

const registry: Registry = (globalThis.cmsScopeRegistry ??= { tables: null, collections: new Set(), loading: null });

/** Record and translation tables both start like this, and nothing else does. */
export const isRecordTable = (name: string) => name.startsWith("rec_") || name.startsWith("loc_");

/** Null until loaded. */
export const scopedTables = (): ReadonlySet<string> | null => registry.tables;

/** Ids of the scoped collections. Empty until loaded. */
export const scopedCollectionIds = (): ReadonlySet<number> => registry.collections;

export async function reloadScopeRegistry() {
  const collections = await prisma.collection.findMany({ where: { scoped: true }, select: { id: true, slug: true } });
  registry.collections = new Set(collections.map(({ id }) => id));
  registry.tables = new Set(collections.flatMap(({ slug }) => [tableName(slug), localeTableName(slug)]));
}

/** Loads once. Safe to await on every request. */
export function ensureScopeRegistry(): Promise<void> {
  if (registry.tables) return Promise.resolve();
  registry.loading ??= reloadScopeRegistry().finally(() => { registry.loading = null; });
  return registry.loading;
}

/** For unit tests, which have no database. */
export function setScopedTablesForTests(tables: Iterable<string> | null) {
  registry.tables = tables === null ? null : new Set(tables);
}
