import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Row scopes (SECURITY_MODEL.md, "Row scopes"). A scope provider, from one plugin, splits
 * records by a value it resolves per request, such as a tenant. This module only holds the
 * value for the work in progress. Everything that reads or writes a scoped record table
 * passes through core/scope/plugin.ts, which reads it here and fails closed without one.
 */

/** The column every scoped record table and its translations carry. Field names start with a letter, so none can clash. */
export const SCOPE_COLUMN = "_scope";

/** Scope values are short opaque ids chosen by the provider. Checked wherever one enters. */
export const SCOPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type ScopeState =
  /** Work for one scope value, or for none: a request that resolved no value can't touch scoped records. */
  | { kind: "value"; value: string | null }
  /** Trusted work across every value, such as schema changes, jobs keyed by record id, and exports. Never a request. */
  | { kind: "all"; reason: string };

// One store per process. In development Next can load this module more than once, while
// recordsDb, whose scope plugin reads this store, is kept on globalThis (core/content/db.ts).
// A second store would leave that plugin reading one no request ever enters.
declare const globalThis: { cmsScopeStorage?: AsyncLocalStorage<ScopeState> } & typeof global;
const storage = (globalThis.cmsScopeStorage ??= new AsyncLocalStorage<ScopeState>());

export const currentScope = (): ScopeState | undefined => storage.getStore();

/** The scope value the current work is for, or null outside one. */
export function currentScopeValue(): string | null {
  const state = storage.getStore();
  return state?.kind === "value" ? state.value : null;
}

export function isScopeValue(value: unknown): value is string {
  return typeof value === "string" && SCOPE_VALUE.test(value);
}

/** Runs work for one scope value, or for none with null. */
export function withScope<T>(value: string | null, work: () => T): T {
  if (value !== null && !isScopeValue(value)) throw new Error(`Not a scope value: ${JSON.stringify(value)}`);
  return storage.run({ kind: "value", value }, work);
}

/**
 * Wraps work to run later, from a timer or a queue, in the scope state it was wrapped in. It
 * can only go back to a state it was already in, so it never widens what the work reaches.
 */
export function bindScope<A extends unknown[], R>(work: (...args: A) => R): (...args: A) => R {
  const state = storage.getStore();
  return (...args: A) => (state ? storage.run(state, () => work(...args)) : storage.exit(() => work(...args)));
}

/** Only the plugin that provides row scopes may move or remove a value's data. */
async function providerOnly(source: string) {
  const { scopeProvider } = await import("./provider");
  if (scopeProvider()?.plugin !== source.replace(/^plugin:/, "")) throw new Error("Only the plugin that provides row scopes can export, import or purge a scope value's data.");
  return import("./data");
}

/** What a plugin sees of row scopes, as `context.scope`. `source` is who is acting, such as plugin:multi-tenant. */
export const extensionScope = (source: string) => ({
  value: currentScopeValue,
  bind: bindScope,
  siteUrl: async () => (await import("./provider")).scopeSiteUrl(),
  data: {
    usage: async (value: string) => (await import("./data")).scopeUsage(value),
    export: async (value: string) => (await providerOnly(source)).exportScope(value),
    import: async (value: string, file: string) => (await providerOnly(source)).importScope(value, file),
    purge: async (value: string) => (await providerOnly(source)).purgeScope(value),
  },
  forgetLimits: async (value?: string) => (await import("./limits")).forgetScopeLimits(value),
});

/**
 * Runs trusted work across every scope value. It can read and change scoped rows by id, but
 * can't create one, which needs a value. `reason` says why, and a contract test lists every
 * call, so each one is reviewed like a security change.
 */
export function unscoped<T>(reason: string, work: () => T): T {
  return storage.run({ kind: "all", reason }, work);
}
