import "server-only";
import { getCmsConfig } from "../config";

/**
 * Origins plugins trust besides the owner's list (`auth.trustedOrigins` in a plugin's
 * manifest), such as the verified domains of a tenant's site, where its members sign in.
 * Read again at most every few seconds, so the checks that use them stay synchronous, and at
 * once on the server where a plugin says they changed. Each one must be a plain http(s)
 * origin: no patterns, so a plugin can only name sites it knows.
 */
interface OriginsState { origins: string[]; loadedAt: number; loading: Promise<void> | null }

declare const globalThis: { cmsPluginOrigins?: OriginsState } & typeof global;

// On globalThis because Next.js can load this module more than once in one process.
const state: OriginsState = (globalThis.cmsPluginOrigins ??= { origins: [], loadedAt: 0, loading: null });

const FRESH_MS = 30_000;
const MAX_ORIGINS = 5000;

/** The origin itself, lower-case, when `value` is exactly one, else null. */
export function plainOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("*")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === value.toLowerCase().replace(/\/$/, "") ? url.origin : null;
  } catch {
    return null;
  }
}

async function load() {
  const plugins = (getCmsConfig().plugins ?? []).filter((plugin) => plugin.auth?.trustedOrigins);
  if (!plugins.length) {
    state.origins = [];
    return;
  }
  const { extensionContext } = await import("../extend/hooks");
  const found = new Set<string>();
  for (const plugin of plugins) {
    try {
      const listed = await plugin.auth!.trustedOrigins!(extensionContext(`plugin:${plugin.name}`));
      for (const value of Array.isArray(listed) ? listed : []) {
        const origin = plainOrigin(value);
        if (origin) found.add(origin);
        else console.error(`[origins] ${plugin.name}: "${String(value).slice(0, 100)}" isn't a plain http(s) origin, so it isn't trusted`);
      }
    } catch (error) {
      // A plugin that fails adds nothing, and the last answer it gave is dropped with the rest of its list.
      console.error(`[origins] ${plugin.name} could not list its trusted origins`, error);
    }
  }
  state.origins = [...found].slice(0, MAX_ORIGINS);
}

/** Reads them again when they're older than a few seconds, or at once with `force`. Safe to await on every request. */
export function refreshPluginOrigins(force = false): Promise<void> {
  if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) return Promise.resolve();
  if (state.loading && !force) return state.loading;
  const run = load().finally(() => {
    state.loadedAt = Date.now();
    if (state.loading === run) state.loading = null;
  });
  state.loading = run;
  return run;
}

/** As last read. Await refreshPluginOrigins() first. */
export const pluginOrigins = (): readonly string[] => state.origins;
