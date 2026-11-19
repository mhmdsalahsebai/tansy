/** OTLP/HTTP with JSON: the address, the headers, and log records for both logs. No server imports, so it's easy to test. */

/** One audit entry as this plugin sends it: the event as core recorded it, stamped on arrival. */
export interface AuditRecordInput {
  /** Unique, and the same on every attempt, so a backend can drop a repeat. */
  id: string;
  /** ISO 8601, in UTC. */
  at: string;
  action: string;
  outcome: "success" | "failure" | "denied";
  actorId?: string | null;
  actorEmail?: string | null;
  actorKind?: string;
  targetType?: string;
  targetId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  scope?: string | null;
  /** Already sanitized by core. */
  metadata?: Record<string, unknown>;
}

/** One request log entry, as the request-logs plugin hands it to a destination. */
export interface RequestRecordInput {
  at: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  actorId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface OtlpOptions {
  /**
   * The OTLP/HTTP base address, such as http://collector:4318 or
   * https://otlp-gateway-prod-eu-west-2.grafana.net/otlp. Logs go to its /v1/logs. Defaults to
   * OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (the full address) or OTEL_EXPORTER_OTLP_ENDPOINT.
   */
  endpoint?: string;
  /** Sent with each request, for the backend's key. Defaults to OTEL_EXPORTER_OTLP_HEADERS, as `name=value,name=value`. */
  headers?: Record<string, string>;
  /** The `service.name` the logs are under. Defaults to OTEL_SERVICE_NAME, then "tansy". */
  serviceName?: string;
  /** Milliseconds per request. 10 seconds when left out. */
  timeoutMs?: number;
}

/** `name=value,name=value`, with values percent-encoded, as OpenTelemetry's variables have them. */
export function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (value ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    let text = pair.slice(at + 1).trim();
    try {
      text = decodeURIComponent(text);
    } catch {
      // Left as written.
    }
    if (name) headers[name] = text;
  }
  return headers;
}

/**
 * The logs address: a base address gets /v1/logs, a full logs address is used as it is. Only
 * http and https, and no user, password or query in it: keys go in headers.
 */
export function logsUrl({ base, full }: { base?: string; full?: string }): string {
  const given = base ?? full;
  let url: URL;
  try {
    url = new URL(given ?? "");
  } catch {
    throw new Error("OTLP logs need an endpoint, such as http://collector:4318. Set it or OTEL_EXPORTER_OTLP_ENDPOINT.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The OTLP endpoint must start with https:// or http://.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The OTLP endpoint can't hold a user, password, query or fragment. Pass keys as headers.");
  const address = url.href.replace(/\/+$/, "");
  return base === undefined ? address : `${address}/v1/logs`;
}

/** Where to send and how, from the options and then OpenTelemetry's own variables, in the order OpenTelemetry reads them. */
export function resolveOptions(options: OtlpOptions, env: Record<string, string | undefined> = process.env) {
  const url = options.endpoint !== undefined || !env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    ? logsUrl({ base: options.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT })
    : logsUrl({ full: env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT });
  return {
    url,
    headers: { "content-type": "application/json", ...(options.headers ?? parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)) },
    serviceName: options.serviceName ?? env.OTEL_SERVICE_NAME ?? "tansy",
    timeoutMs: options.timeoutMs ?? 10_000,
  };
}

type Value = { stringValue: string } | { intValue: string } | { boolValue: boolean };
interface Attribute { key: string; value: Value }

const attribute = (key: string, value: unknown): Attribute[] => {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
  if (typeof value === "number" && Number.isInteger(value)) return [{ key, value: { intValue: String(value) } }];
  return [{ key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } }];
};

/** Milliseconds with six zeros, as a string: past 2^53, so never through a number. */
const nanos = (iso: string) => `${Date.parse(iso)}000000`;

/** OpenTelemetry's severity numbers: INFO 9, WARN 13, ERROR 17. */
const severity = (level: "INFO" | "WARN" | "ERROR") => ({ severityNumber: { INFO: 9, WARN: 13, ERROR: 17 }[level], severityText: level });

export function auditRecord(entry: AuditRecordInput) {
  return {
    timeUnixNano: nanos(entry.at),
    ...severity(entry.outcome === "success" ? "INFO" : "WARN"),
    eventName: entry.action,
    body: { stringValue: entry.action },
    attributes: [
      ...attribute("log.name", "audit"),
      ...attribute("event.name", entry.action),
      ...attribute("tansy.audit.id", entry.id),
      ...attribute("tansy.audit.outcome", entry.outcome),
      ...attribute("tansy.scope", entry.scope),
      ...attribute("enduser.id", entry.actorId),
      ...attribute("tansy.actor.email", entry.actorEmail),
      ...attribute("tansy.actor.kind", entry.actorKind),
      ...attribute("tansy.target.type", entry.targetType),
      ...attribute("tansy.target.id", entry.targetId),
      ...attribute("client.address", entry.ipAddress),
      ...attribute("user_agent.original", entry.userAgent),
      ...attribute("tansy.audit.metadata", entry.metadata && Object.keys(entry.metadata).length ? entry.metadata : null),
    ],
  };
}

export function requestRecord(entry: RequestRecordInput) {
  return {
    timeUnixNano: nanos(entry.at),
    ...severity(entry.status >= 500 ? "ERROR" : entry.status >= 400 ? "WARN" : "INFO"),
    body: { stringValue: `${entry.method} ${entry.path} ${entry.status}` },
    attributes: [
      ...attribute("log.name", "request"),
      ...attribute("http.request.method", entry.method),
      ...attribute("url.path", entry.path),
      ...attribute("http.response.status_code", entry.status),
      ...attribute("tansy.duration_ms", entry.durationMs),
      ...attribute("enduser.id", entry.actorId),
      ...attribute("client.address", entry.ipAddress),
      ...attribute("user_agent.original", entry.userAgent),
    ],
  };
}

/** One OTLP/HTTP JSON export request. */
export const exportRequest = (serviceName: string, logRecords: object[]) => ({
  resourceLogs: [{
    resource: { attributes: attribute("service.name", serviceName) },
    scopeLogs: [{ scope: { name: "tansy" }, logRecords }],
  }],
});

/**
 * Sends records in one request. Only the status of a refusal is reported, never what the
 * backend said back, which can quote the key.
 */
export function createSender(resolved: ReturnType<typeof resolveOptions>, fetcher: typeof fetch = fetch) {
  return async function send(records: object[]) {
    if (!records.length) return;
    let response: Response;
    try {
      response = await fetcher(resolved.url, {
        method: "POST",
        headers: resolved.headers,
        body: JSON.stringify(exportRequest(resolved.serviceName, records)),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(resolved.timeoutMs),
      });
    } catch {
      throw new Error("The OTLP endpoint couldn't be reached.");
    }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`The OTLP endpoint answered ${response.status}.`);
  };
}
