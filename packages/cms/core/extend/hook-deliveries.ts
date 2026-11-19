import "server-only";
import type { HookDelivery } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import type { CollectionWithFields } from "../content/access";
import type { Trx } from "../content/content-service";
import type { RecordRow } from "../content/records";
import { notFound } from "../http/errors";
import type { AfterEvent, HookCollection, RecordValues } from "./define";
import { hookDepth, MAX_HOOK_DEPTH, runAfterHook } from "./hooks";
import { hooksFor } from "./registry";
import { isScopeValue, SCOPE_COLUMN, withScope } from "../scope/context";

/**
 * Seconds before each retry: quickly at first, then every six hours, for about three days.
 * After the last one the delivery is marked failed and shows under Extensions, where it can be retried.
 */
const RETRY_DELAYS = [10, 60, 300, 1800, 7200, ...Array<number>(12).fill(21_600)];
const BATCH = 50;
const KEEP_FAILED_MS = 30 * 86_400_000;
const MAX_ERROR = 500;

const AFTER = { create: "record.afterCreate", update: "record.afterUpdate", delete: "record.afterDelete" } as const satisfies Record<string, AfterEvent>;

/** `scope` is the record's scope value, on a scoped collection, so its hooks run in it. */
interface Payload { collection: HookCollection; record: RecordValues; previous?: RecordValues; scope?: string }

/** In the format Prisma writes, so dates written here and by Prisma compare as text on SQLite. */
const stamp = (date: Date) => date.toISOString().replace(/Z$/, "+00:00");

/**
 * Called inside the record write's transaction, so the write and its after-hooks
 * commit together or not at all. A crash after commit leaves them pending, and
 * the next run delivers them.
 */
export async function enqueueAfterHooks(trx: Trx, collection: CollectionWithFields, action: keyof typeof AFTER, record: RecordRow, previous?: RecordRow) {
  const event = AFTER[action];
  const hooks = hooksFor(event);
  if (!hooks.length) return;
  const depth = hookDepth();
  if (depth >= MAX_HOOK_DEPTH) return console.error(`[hooks] stopped ${event} on ${collection.slug}: too many nested writes.`);
  const scope = (record as Record<string, unknown>)[SCOPE_COLUMN];
  const payload: Payload = { collection: { id: collection.id, slug: collection.slug, name: collection.name }, record, ...(previous ? { previous } : {}), ...(typeof scope === "string" ? { scope } : {}) };
  const text = JSON.stringify(payload);
  const now = stamp(new Date());
  const positions = new Map<string, number>();
  const rows = hooks.map(({ source }) => {
    const position = positions.get(source) ?? 0;
    positions.set(source, position + 1);
    return { source, event, position, collectionId: collection.id, recordId: record.id, payload: text, depth, status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now };
  });
  await trx.insertInto("HookDelivery").values(rows).execute();
}

async function deliver(delivery: HookDelivery) {
  const attempts = delivery.attempts + 1;
  const where = { id: delivery.id };
  const hook = hooksFor(delivery.event as AfterEvent).filter(({ source }) => source === delivery.source)[delivery.position];
  if (!hook) {
    await prisma.hookDelivery.update({ where, data: { attempts, status: "failed", error: "The hook is no longer registered.", finishedAt: new Date() } });
    return;
  }
  const { collection, record, previous, scope } = JSON.parse(delivery.payload) as Payload;
  // A scoped record's hooks run in its scope value, so their settings, store and writes are that value's, as the write's own were.
  const run = () => runAfterHook(hook, delivery.event as AfterEvent, collection, record, previous, delivery.depth);
  try {
    await (isScopeValue(scope) ? withScope(scope, run) : run());
  } catch (error) {
    console.error(`[hooks] ${delivery.source} ${delivery.event} on ${collection.slug}/${record.id}, attempt ${attempts}`, error);
    const delay = RETRY_DELAYS[attempts - 1];
    const message = (error instanceof Error && error.message ? error.message : "The hook failed.").slice(0, MAX_ERROR);
    await prisma.hookDelivery.update({
      where,
      data: { attempts, error: message, ...(delay === undefined ? { status: "failed", finishedAt: new Date() } : { nextAttemptAt: new Date(Date.now() + delay * 1000) }) },
    });
    return;
  }
  await prisma.hookDelivery.deleteMany({ where });
}

interface RunnerState { running: boolean; again: boolean; lastPrune: number }
declare const globalThis: { cmsHookRunner?: RunnerState } & typeof global;
/** On globalThis, because Next.js can load this module more than once, and two runners would deliver twice. */
const state: RunnerState = (globalThis.cmsHookRunner ??= { running: false, again: false, lastPrune: 0 });

/**
 * Delivers every due after-hook, oldest first. Runs after each write commits and on a
 * timer for retries and for anything left by a restart. A call while it runs makes it
 * look again once it finishes, so nothing written meanwhile waits for the timer.
 */
export async function runHookDeliveries() {
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  try {
    do {
      state.again = false;
      let after = 0;
      for (;;) {
        const due = await prisma.hookDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: new Date() }, id: { gt: after } }, orderBy: { id: "asc" }, take: BATCH });
        for (const delivery of due) await deliver(delivery);
        if (due.length < BATCH) break;
        after = due[due.length - 1].id;
      }
    } while (state.again);
    if (Date.now() - state.lastPrune > 3_600_000) {
      state.lastPrune = Date.now();
      await prisma.hookDelivery.deleteMany({ where: { status: "failed", finishedAt: { lt: new Date(Date.now() - KEEP_FAILED_MS) } } });
    }
  } finally {
    state.running = false;
  }
}

/** Failed deliveries, and pending ones that have already failed more than twice. Never the payload, which can hold hidden fields. */
export const listHookProblems = () =>
  prisma.hookDelivery.findMany({
    where: { OR: [{ status: "failed" }, { attempts: { gte: 3 } }] },
    orderBy: { id: "desc" },
    take: 100,
    select: { id: true, source: true, event: true, collectionId: true, recordId: true, status: true, attempts: true, error: true, nextAttemptAt: true, createdAt: true, finishedAt: true },
  });

/** Queues a failed delivery to run again now, with a fresh set of retries. */
export async function retryHookDelivery(id: number) {
  const { count } = await prisma.hookDelivery.updateMany({ where: { id, status: "failed" }, data: { status: "pending", attempts: 0, error: null, finishedAt: null, nextAttemptAt: new Date() } });
  if (!count) throw notFound("Failed hook delivery");
  void runHookDeliveries().catch((error) => console.error("[hooks]", error));
}
