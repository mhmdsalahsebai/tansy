import { createHash, randomBytes } from "node:crypto";
import type { ExtensionScope, PluginStore } from "tansy/plugin";
import { addHit, emptyDay, mergeDay, readDay, today, type DayStats, type Hit } from "./logic";

/**
 * Counts page views in memory and writes them to the plugin's store every few seconds.
 * The CMS runs as one server process, so this is the only writer of these keys, and one
 * flush at a time is enough to never lose an update. A crash loses at most the last few
 * seconds of counts.
 *
 * Telling visitors apart: a hash of a salt, the site, the visitor's address and browser,
 * as Plausible does. The salt is random, kept only in memory and replaced each day, along
 * with the hashes seen. Nothing about a visitor is ever written, and a hash can't be
 * traced back to anyone once the salt is gone. The cost: after a restart, someone who
 * already came that day counts as a new visitor once more.
 *
 * With a scope provider, such as multi-tenant, each scope value's views are kept apart and
 * written in that value, so they land in its own store and never in another tenant's.
 */

const FLUSH_MS = 5_000;
/** Far more than one server sees in a day. Past it, visitors aren't told apart until tomorrow. */
const MAX_SEEN = 500_000;

export const dayKey = (date: string) => `day:${date}`;
export const INDEX_KEY = "days";

export function createCounter(store: () => PluginStore, now: () => Date = () => new Date()) {
  let salt = { day: "", value: Buffer.alloc(0) };
  let seen = new Set<string>();
  /** By scope value, "" outside any. `run` puts the write back in the value the views came from. */
  type Pending = { run: (work: () => Promise<void>) => Promise<void>; days: Map<string, DayStats> };
  let pending = new Map<string, Pending>();
  const here = (work: () => Promise<void>) => work();

  function pendingFor(key: string, run: Pending["run"]) {
    let entry = pending.get(key);
    if (!entry) pending.set(key, entry = { run, days: new Map() });
    return entry;
  }
  let flushing: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function saltFor(day: string) {
    if (salt.day !== day) {
      salt = { day, value: randomBytes(32) };
      seen = new Set();
    }
    return salt.value;
  }

  /** Whether this is the visitor's first page view today. */
  function firstToday(day: string, site: string, ip: string | null, userAgent: string): boolean {
    const hash = createHash("sha256").update(saltFor(day)).update(`${site}\n${ip ?? ""}\n${userAgent}`).digest("base64url").slice(0, 22);
    if (seen.has(hash)) return false;
    if (seen.size >= MAX_SEEN) return false;
    seen.add(hash);
    return true;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch((error: unknown) => console.error("[analytics] counts couldn't be saved", error));
    }, FLUSH_MS);
    timer.unref?.();
  }

  function count(hit: Omit<Hit, "newVisitor">, visitor: { site: string; ip: string | null; userAgent: string }, scope?: ExtensionScope) {
    const day = today(now());
    const { days } = pendingFor(scope?.value() ?? "", scope ? scope.bind(here) : here);
    const delta = days.get(day) ?? emptyDay();
    addHit(delta, { ...hit, newVisitor: firstToday(day, visitor.site, visitor.ip, visitor.userAgent) });
    days.set(day, delta);
    schedule();
  }

  async function writeDay(day: string, delta: DayStats) {
    const kv = store();
    const stored = await kv.get(dayKey(day));
    await kv.set(dayKey(day), mergeDay(readDay(stored), delta));
    if (stored === null) {
      const index = await kv.get(INDEX_KEY);
      const days = Array.isArray(index) ? index.filter((value): value is string => typeof value === "string") : [];
      if (!days.includes(day)) await kv.set(INDEX_KEY, [...days, day].sort());
    }
  }

  async function write() {
    const batch = pending;
    pending = new Map();
    let failure: unknown = null;
    for (const [key, { run, days }] of batch) {
      for (const [day, delta] of days) {
        try {
          await run(() => writeDay(day, delta));
        } catch (error) {
          // Put it back for the next flush rather than lose it.
          const entry = pendingFor(key, run);
          entry.days.set(day, mergeDay(delta, entry.days.get(day) ?? emptyDay()));
          schedule();
          failure ??= error;
        }
      }
    }
    if (failure) throw failure;
  }

  /** Writes what's counted so far. Runs one at a time. */
  function flush(): Promise<void> {
    const next = flushing.then(write, write);
    flushing = next.catch(() => {});
    return next;
  }

  return { count, flush };
}

export type Counter = ReturnType<typeof createCounter>;
