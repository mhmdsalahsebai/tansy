import { z } from "zod";
import { apiPath, definePlugin, defineRoute, type ApiRequest, type ExtensionContext, type PluginSettingField } from "tansy/plugin";
import { checkedDestinations, type RequestLogDestination } from "./destinations";
import { messages } from "./messages";
import { BATCH_PREFIX, batchKey, cutoffKey, findEntries, kept, skipList, toBatches, WHICH, type RequestLogEntry, type Which } from "./logic";

export { consoleDestination, httpDestination, jsonLines, storageDestination, type HttpDestinationOptions, type RequestLogDestination } from "./destinations";
export type { RequestLogEntry } from "./logic";

export interface RequestLogsOptions {
  /**
   * Places outside the database that entries are also sent to: `storageDestination(s3Storage(...))`
   * for S3 and other storage, `httpDestination({ url })` for a log service, `consoleDestination()`
   * for the server's output, or any object with a name and `write`.
   */
  destinations?: RequestLogDestination[];
  /** Whether entries are kept in the database until changed in the settings. On when left out. */
  database?: boolean;
  /** Which requests are logged until changed in the settings. "all" when left out. */
  which?: Which;
  /** How many days entries stay in the database until changed in the settings. 7 when left out. */
  retentionDays?: number;
}

const NAME = "request-logs";
const PERMISSION = "ext.request-logs:read";
const FLUSH_MS = 2000;
/** Entries waiting in memory, and per destination for a retry. Past it, new ones are dropped and counted. */
const MAX_WAITING = 5000;
const SETTINGS_TTL_MS = 30_000;
const DEFAULT_SKIP = "/api/realtime";

const optionsSchema = z.strictObject({
  destinations: z.array(z.object({ name: z.string(), label: z.string(), write: z.custom<(entries: unknown[]) => Promise<void>>((write) => typeof write === "function") }).loose()),
  database: z.boolean(),
  which: z.enum(WHICH),
  retentionDays: z.number().int().min(1).max(365),
});

interface Settings { enabled: boolean; which: Which; database: boolean; destinations: boolean; storeIp: boolean; skip: string[]; retentionDays: number }

interface State {
  waiting: RequestLogEntry[];
  /** Entries a destination refused, kept for its next write. */
  retry: Map<string, RequestLogEntry[]>;
  dropped: number;
  timer: NodeJS.Timeout | null;
  flushing: Promise<void> | null;
  settings: { at: number; value: Settings } | null;
}

// On globalThis because Next.js can load the config in more than one copy of a module.
declare const globalThis: { cmsRequestLogs?: State } & typeof global;

/**
 * A log of every API request, kept in the database and shown on the dashboard, sent to S3
 * or any storage, a log service, or the server's output, or all of them. See docs/plugins/request-logs.md.
 */
export function requestLogs(options: RequestLogsOptions = {}) {
  const value = optionsSchema.parse({ destinations: [], database: true, which: "all", retentionDays: 7, ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const destinations = checkedDestinations(options.destinations ?? []);
  const state: State = (globalThis.cmsRequestLogs ??= { waiting: [], retry: new Map(), dropped: 0, timer: null, flushing: null, settings: null });
  const own = apiPath(`/ext/${NAME}`);

  const fields: PluginSettingField[] = [
    { name: "enabled", type: "boolean", default: true, label: "Log API requests", description: "When off, nothing new is logged anywhere." },
    { name: "which", type: "select", default: value.which, label: "Which requests", description: "Reads that worked are most of them, and the least useful.", options: [{ value: "all", label: "All of them" }, { value: "writes", label: "Changes and errors" }, { value: "errors", label: "Errors only" }] },
    { name: "database", type: "boolean", default: value.database, label: "Keep them in the database", description: "Shown on this page. Turn it off to send them only to the places below." },
    ...(destinations.length ? [{ name: "destinations", type: "boolean" as const, default: true, label: "Also send them outside", description: `To ${destinations.map((destination) => destination.label).join(", ")}.` }] : []),
    { name: "storeIp", type: "boolean", default: true, label: "Keep IP addresses and browsers", description: "Off keeps neither, for privacy." },
    { name: "skip", type: "text", default: DEFAULT_SKIP, multiline: true, maxLength: 2000, label: "Addresses not to log", description: "One per line, such as /api/realtime. Each covers everything under it." },
    { name: "retentionDays", type: "number", default: value.retentionDays, min: 1, max: 365, integer: true, label: "Keep entries here for (days)", description: "Older entries are deleted each night." },
  ];

  async function settingsOf(context: ExtensionContext, { fresh = false } = {}): Promise<Settings> {
    if (!fresh && state.settings && Date.now() - state.settings.at < SETTINGS_TTL_MS) return state.settings.value;
    const saved = await context.settings.get();
    const settings: Settings = {
      enabled: saved.enabled !== false,
      which: WHICH.includes(saved.which as Which) ? saved.which as Which : value.which,
      database: saved.database === undefined ? value.database : saved.database === true,
      destinations: destinations.length > 0 && saved.destinations !== false,
      storeIp: saved.storeIp !== false,
      skip: skipList(saved.skip ?? DEFAULT_SKIP),
      retentionDays: Math.min(365, Math.max(1, Number(saved.retentionDays) || value.retentionDays)),
    };
    state.settings = { at: Date.now(), value: settings };
    return settings;
  }

  /** Sends what each destination has waiting. One that fails keeps its entries for next time, up to the limit. */
  async function send(entries: RequestLogEntry[]) {
    await Promise.all(destinations.map(async (destination) => {
      const pending = [...(state.retry.get(destination.name) ?? []), ...entries];
      if (!pending.length) return;
      try {
        await destination.write(pending);
        state.retry.delete(destination.name);
      } catch (error) {
        console.error(`[request-logs] couldn't send to ${destination.name}:`, error instanceof Error ? error.message : error);
        state.retry.set(destination.name, pending.slice(-MAX_WAITING));
      }
    }));
  }

  /** Writes what's waiting. One write at a time per server. */
  function flush(context: ExtensionContext): Promise<void> {
    state.flushing ??= (async () => {
      try {
        while (state.waiting.length) {
          const taken = state.waiting.splice(0);
          const settings = await settingsOf(context);
          if (!settings.enabled) continue;
          const entries = taken
            .filter((entry) => kept(settings.which, entry) && !settings.skip.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix.replace(/\/+$/, "")}/`)))
            .map((entry) => (settings.storeIp ? entry : { ...entry, ipAddress: null, userAgent: null }));
          if (!entries.length) continue;
          if (settings.database) {
            for (const batch of toBatches(entries)) {
              await context.store.set(batchKey(batch[0].at, crypto.randomUUID().slice(0, 8)), batch).catch((error: unknown) => console.error("[request-logs] couldn't save entries:", error));
            }
          }
          if (settings.destinations) await send(entries);
        }
        if (state.dropped) {
          console.warn(`[request-logs] dropped ${state.dropped} entries because too many were waiting`);
          state.dropped = 0;
        }
      } finally {
        state.flushing = null;
      }
    })();
    return state.flushing;
  }

  function onRequest(request: ApiRequest, context: ExtensionContext) {
    // The log's own page reading it isn't worth logging.
    if (request.path === own || request.path.startsWith(`${own}/`)) return;
    if (state.settings && !state.settings.value.enabled && Date.now() - state.settings.at < SETTINGS_TTL_MS) return;
    if (state.waiting.length >= MAX_WAITING) {
      state.dropped += 1;
      return;
    }
    state.waiting.push({ ...request, at: request.at.toISOString() });
    state.timer ??= setTimeout(() => {
      state.timer = null;
      void flush(context).catch((error: unknown) => console.error("[request-logs]", error));
    }, FLUSH_MS);
    state.timer.unref?.();
  }

  return definePlugin({
    name: NAME,
    version: "0.1.0",
    apiVersion: 1,
    requires: { cms: "^0.1.0" },
    admin: { server: "@tansy/request-logs/admin" },
    options: { schema: optionsSchema, value },
    messages,
    permissions: { "ext.request-logs": ["read"] },
    settings: { fields },
    onRequest,
    routes: [
      defineRoute({
        method: "GET",
        path: "/entries",
        access: "permission",
        permission: PERMISSION,
        query: z.object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
          path: z.string().max(200).optional(),
          status: z.enum(["2xx", "3xx", "4xx", "5xx"]).optional(),
          before: z.string().startsWith(BATCH_PREFIX).max(200).optional(),
        }),
        handler: async (context) => {
          // What this server still holds shows up straight away.
          await flush(context).catch(() => undefined);
          const settings = await settingsOf(context, { fresh: true });
          const { method, path, status, before } = context.query;
          const { items, next } = await findEntries((cursor, limit) => context.store.list(BATCH_PREFIX, { before: cursor, order: "desc", limit }), { method, path, status }, { before });
          return {
            items,
            next,
            enabled: settings.enabled,
            database: settings.database,
            destinations: settings.destinations ? destinations.map((destination) => destination.label) : [],
          };
        },
      }),
    ],
    jobs: [
      {
        name: "request-logs.prune",
        cron: "41 3 * * *",
        handler: async (context) => {
          const settings = await settingsOf(context, { fresh: true });
          await context.store.deleteMany(BATCH_PREFIX, { before: cutoffKey(settings.retentionDays) });
        },
      },
    ],
  });
}
