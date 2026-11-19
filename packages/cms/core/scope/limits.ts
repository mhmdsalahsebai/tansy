import "server-only";
import { HttpError } from "../http/errors";
import { consumeReadLimit } from "../http/read-limit";
import { currentScopeValue, isScopeValue } from "./context";
import { scopeProvider } from "./provider";

/**
 * Limits on one scope value, such as a tenant's plan (Phase 24): how many records it may hold,
 * how many bytes of files, and how many API requests a minute across all its callers. The
 * provider names them per value, and core checks them where records are made, files uploaded
 * and requests answered, so no route can skip them. Values without limits, and instances
 * without a provider, are never limited.
 */
export interface ScopeLimits {
  records?: number | null;
  storageBytes?: number | null;
  requestsPerMinute?: number | null;
}

const LIMITS_TTL_MS = 15_000;

declare const globalThis: { cmsScopeLimits?: Map<string, { at: number; limits: ScopeLimits }> } & typeof global;
const cache = (globalThis.cmsScopeLimits ??= new Map());

/** Forgets what was read, such as after a value's limits change. */
export function forgetScopeLimits(value?: string) {
  if (value) cache.delete(value);
  else cache.clear();
}

const positive = (limit: unknown) => (typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? limit : null);

/** The value's limits, held for a few seconds. A provider that fails or names none limits nothing. */
export async function scopeLimits(value: string): Promise<ScopeLimits> {
  const active = scopeProvider();
  if (!active?.provider.limits || !isScopeValue(value)) return {};
  const hit = cache.get(value);
  if (hit && Date.now() - hit.at < LIMITS_TTL_MS) return hit.limits;
  const context = (await import("../extend/hooks")).extensionContext(`plugin:${active.plugin}`);
  let limits: ScopeLimits = {};
  try {
    const given = await active.provider.limits(value, context);
    limits = { records: positive(given?.records), storageBytes: positive(given?.storageBytes), requestsPerMinute: positive(given?.requestsPerMinute) };
  } catch (error) {
    console.error(`[scope] ${active.plugin} could not give limits for ${value}`, error);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(value, { at: Date.now(), limits });
  return limits;
}

const reached = (what: string) => new HttpError(403, "SCOPE_LIMIT_REACHED", `This ${(scopeProvider()?.provider.label ?? "scope").toLowerCase()} has reached its limit on ${what}.`);

/** Before a record is made in the current value. Pass the transaction the record is written in, if any. */
export async function assertRecordRoom(db?: Parameters<typeof import("./data").scopeRecordCount>[1], count = 1) {
  const value = currentScopeValue();
  if (value === null) return;
  const { records } = await scopeLimits(value);
  if (records === null || records === undefined) return;
  const { scopeRecordCount } = await import("./data");
  if ((await scopeRecordCount(value, db)) + count > records) throw reached("records");
}

/** Before `bytes` more of files are kept for the current value. */
export async function assertStorageRoom(bytes: number) {
  const value = currentScopeValue();
  if (value === null) return;
  const { storageBytes } = await scopeLimits(value);
  if (storageBytes === null || storageBytes === undefined) return;
  const { scopeUsage } = await import("./data");
  if ((await scopeUsage(value)).storageBytes + bytes > storageBytes) throw reached("storage");
}

/** One request for `value`, counted against its budget for the minute. */
export async function consumeScopeRequest(value: string | null | undefined) {
  if (!value) return;
  const { requestsPerMinute } = await scopeLimits(value);
  if (requestsPerMinute === null || requestsPerMinute === undefined) return;
  if (!consumeReadLimit(`scope:${value}`, 60, requestsPerMinute)) throw new HttpError(429, "RATE_LIMITED", "Too many requests.");
}
