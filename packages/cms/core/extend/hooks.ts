import "server-only";
import { extensionScope } from "../scope/context";
import { AsyncLocalStorage } from "node:async_hooks";
import { ANONYMOUS, systemPrincipal } from "../authz/principal";
import { grants } from "../authz/permissions";
import { HttpError } from "../http/errors";
import type { AfterEvent, AfterHook, BeforeEvent, BeforeHook, ExtensionContext, HookCollection, LifecycleData, LifecycleEvent, LifecycleHook, RecordValues } from "./define";
import { scopedRecords } from "./records";
import { hooksFor, type HookEntry } from "./registry";
import { extensionMail } from "./mail";
import { extensionCaptcha } from "../captcha";
import { extensionSchema } from "./schema";
import { pluginStore } from "./store";
import { extensionSettings } from "./settings";
import { extensionUsers } from "./users";

const MAX_DEPTH = 4;
const BEFORE_TIMEOUT_MS = 10_000;
const AFTER_TIMEOUT_MS = 60_000;

/** Tracks writes made from inside hooks, so a hook that triggers itself stops instead of looping forever. */
const nesting = new AsyncLocalStorage<number>();
const nested = <T>(work: () => T) => nesting.run((nesting.getStore() ?? 0) + 1, work);

/** `source` says who is acting, such as plugin:seo, for the audit log and the store's namespace. */
export const extensionContext = (source: string): ExtensionContext => ({
  records: scopedRecords(ANONYMOUS),
  system: { records: scopedRecords(systemPrincipal(source), new Headers(), source), users: extensionUsers(source) },
  store: pluginStore(source.replace(/^plugin:/, "")),
  mail: extensionMail(source),
  captcha: extensionCaptcha,
  schema: extensionSchema,
  scope: extensionScope(source),
  settings: extensionSettings(source),
});

function withTimeout<T>(work: Promise<T>, ms: number, label: string) {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const describe = ({ id, slug, name }: HookCollection): HookCollection => ({ id, slug, name });

export const hasHooks = (event: BeforeEvent) => hooksFor(event).length > 0;

/** Who is writing: a person, a key's owner, a visitor (no id, nothing held) or a system write (no id, everything held). */
export interface HookActor { userId: string | null; permissions?: ReadonlySet<string> }

const reject = (message: string, field?: string): never => {
  throw new HttpError(400, "HOOK_REJECTED", message, field ? [{ path: field, message }] : undefined);
};

/**
 * Runs before a write and outside its transaction, so a slow hook can't hold
 * SQLite's write lock. A hook failing stops the write. The caller must validate
 * whatever comes back, since hooks can return anything.
 */
export async function runBeforeHooks(event: BeforeEvent, collection: HookCollection, input: { actor: HookActor; status?: "draft" | "published"; values: RecordValues; record?: RecordValues }): Promise<RecordValues> {
  if ((nesting.getStore() ?? 0) >= MAX_DEPTH) throw new HttpError(500, "HOOK_LOOP", "Hooks triggered too many nested writes.");
  const held = input.actor.permissions ?? new Set<string>();
  const can = (permission: string) => grants(held, permission);
  const context = { ...extensionContext("system"), event, collection: describe(collection), userId: input.actor.userId, can, status: input.status, values: { ...input.values }, record: input.record, reject };
  for (const hook of hooksFor(event)) {
    Object.assign(context, extensionContext(hook.source));
    try {
      const result = await nested(() => withTimeout(Promise.resolve().then(() => (hook.fn as BeforeHook)(context)), BEFORE_TIMEOUT_MS, `${hook.source} ${event}`));
      if (result && typeof result === "object") context.values = result;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error(`[hooks] ${hook.source} ${event}`, error);
      throw new HttpError(500, "HOOK_FAILED", "Something went wrong.");
    }
  }
  return context.values;
}

/** How many hook-triggered writes deep the current code runs. */
export const hookDepth = () => nesting.getStore() ?? 0;
export const MAX_HOOK_DEPTH = MAX_DEPTH;

/**
 * Runs one record after-hook for its durable delivery (hook-deliveries.ts), at the depth
 * of the write that queued it. Throws when the hook fails or times out, so it's retried.
 */
export async function runAfterHook(hook: HookEntry, event: AfterEvent, collection: HookCollection, record: RecordValues, previous: RecordValues | undefined, depth: number) {
  const context = { ...extensionContext(hook.source), event, collection: describe(collection), record, ...(previous && event === "record.afterUpdate" ? { previous } : {}) };
  await nesting.run(depth + 1, () => withTimeout(Promise.resolve().then(() => (hook.fn as AfterHook)(context)), AFTER_TIMEOUT_MS, `${hook.source} ${event}`));
}

/** Runs off the request, after commit, so a failure is only logged. */
export async function runLifecycleHooks<E extends LifecycleEvent>(event: E, data: LifecycleData[E]) {
  if ((nesting.getStore() ?? 0) >= MAX_DEPTH) return console.error(`[hooks] stopped ${event}: too many nested writes.`);
  for (const hook of hooksFor(event)) {
    const context = { ...extensionContext(hook.source), event, data };
    await nested(() => withTimeout(Promise.resolve().then(() => (hook.fn as LifecycleHook<E>)(context)), AFTER_TIMEOUT_MS, `${hook.source} ${event}`))
      .catch((error) => console.error(`[hooks] ${hook.source} ${event}`, error));
  }
}
