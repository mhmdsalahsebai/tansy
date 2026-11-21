import { randomUUID } from "node:crypto";
import { definePlugin, type AuditEvent } from "tansy/plugin";
import { auditRecord, createSender, requestRecord, resolveOptions, type AuditRecordInput, type OtlpOptions, type RequestRecordInput } from "./otlp";

export { auditRecord, exportRequest, logsUrl, parseHeaders, requestRecord } from "./otlp";
export type { OtlpOptions } from "./otlp";

const NAME = "logs-otlp";
const FLUSH_MS = 2000;
const BATCH = 500;
/** Entries held while the backend is down. Past it, the oldest are dropped and counted. */
const MAX_WAITING = 10_000;
/** Seconds before each retry, the last repeated. */
const RETRY_DELAYS = [5, 30, 120, 600];

interface State {
  waiting: AuditRecordInput[];
  dropped: number;
  failures: number;
  timer: NodeJS.Timeout | null;
  sending: Promise<void> | null;
}

// On globalThis because Next.js can load the config in more than one copy of a module.
declare const globalThis: { cmsLogsOtlp?: State } & typeof global;

/**
 * Sends the audit log over OpenTelemetry (OTLP/HTTP with JSON), which Grafana Cloud, Honeycomb,
 * New Relic, SigNoz, Datadog, Axiom and any OpenTelemetry Collector take. The database keeps its
 * copy as before; this is a copy outside it. Entries are batched every few seconds and retried
 * with backoff while the backend is down, held in memory up to a limit, so a restart during an
 * outage loses what was waiting: the database still has them. See docs/plugins/logs-otlp.md.
 *
 * For the request log, put `otlpDestination()` in the request-logs plugin's destinations.
 */
export function logsOtlp(options: OtlpOptions = {}, fetcher: typeof fetch = fetch) {
  const send = createSender(resolveOptions(options), fetcher);
  const state: State = (globalThis.cmsLogsOtlp ??= { waiting: [], dropped: 0, failures: 0, timer: null, sending: null });

  function schedule(ms: number) {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush();
    }, ms);
    state.timer.unref?.();
  }

  /** Sends what's waiting, a batch at a time. A failure keeps the batch and waits longer before the next try. */
  function flush(): Promise<void> {
    state.sending ??= (async () => {
      try {
        while (state.waiting.length) {
          const batch = state.waiting.slice(0, BATCH);
          try {
            await send(batch.map(auditRecord));
          } catch (error) {
            state.failures += 1;
            const delay = RETRY_DELAYS[Math.min(state.failures - 1, RETRY_DELAYS.length - 1)];
            if (state.failures >= 3) console.error(`[${NAME}] couldn't send the audit log ${state.failures} times in a row:`, error instanceof Error ? error.message : error);
            schedule(delay * 1000);
            return;
          }
          state.waiting.splice(0, batch.length);
          state.failures = 0;
        }
        if (state.dropped) {
          console.warn(`[${NAME}] dropped ${state.dropped} audit entries because too many were waiting`);
          state.dropped = 0;
        }
      } finally {
        state.sending = null;
      }
    })();
    return state.sending;
  }

  function onAudit(event: AuditEvent) {
    state.waiting.push({ ...event, id: randomUUID(), at: new Date().toISOString() });
    if (state.waiting.length > MAX_WAITING) state.dropped += state.waiting.splice(0, state.waiting.length - MAX_WAITING).length;
    // While retrying, the backoff timer is already set and this waits for it.
    if (state.failures === 0) schedule(FLUSH_MS);
  }

  return definePlugin({
    name: NAME,
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    auth: { onAudit },
  });
}

/**
 * The request log over OTLP, as a destination for the request-logs plugin:
 * `requestLogs({ destinations: [otlpDestination()] })`. It takes the same options and variables
 * as `logsOtlp`. The request-logs plugin batches and retries.
 */
export function otlpDestination(options: OtlpOptions & { name?: string; label?: string } = {}, fetcher: typeof fetch = fetch) {
  const resolved = resolveOptions(options);
  const send = createSender(resolved, fetcher);
  return {
    name: options.name ?? "otlp",
    label: options.label ?? `OpenTelemetry (${new URL(resolved.url).host})`,
    write: (entries: RequestRecordInput[]) => send(entries.map(requestRecord)),
  };
}
