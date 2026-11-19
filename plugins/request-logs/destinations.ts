import type { StorageAdapter } from "tansy/storage";
import type { RequestLogEntry } from "./logic";

/**
 * Somewhere outside the database that request logs are sent, as they are written. Anything
 * with a name and a `write` works: a log service's API, a queue, a file. `write` gets a few
 * seconds' worth of entries at a time. Throwing means "try again later": the entries are
 * kept for the next write, up to a limit.
 */
export interface RequestLogDestination {
  /** Lowercase letters, digits and hyphens. Unique among the plugin's destinations. */
  name: string;
  /** Shown on the dashboard, such as "S3 (logs-bucket)". */
  label: string;
  write(entries: RequestLogEntry[]): Promise<void>;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

export function checkedDestinations(destinations: RequestLogDestination[]) {
  const seen = new Set<string>();
  for (const destination of destinations) {
    if (!NAME.test(destination.name)) throw new Error(`Request logs: "${destination.name}" isn't a destination name. Use lowercase letters, digits and hyphens.`);
    if (seen.has(destination.name)) throw new Error(`Request logs: the destination "${destination.name}" is listed twice.`);
    if (typeof destination.write !== "function") throw new Error(`Request logs: the destination "${destination.name}" has no write().`);
    seen.add(destination.name);
  }
  return destinations;
}

/** One JSON object a line, the format log tools read. */
export const jsonLines = (entries: RequestLogEntry[]) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

/** Where a file of entries goes: `<prefix>/2026/11/16/12-30-05.123Z-<random>.jsonl`, so a day's files list together and sort by time. */
export function fileKey(prefix: string, at: string, random: string) {
  const [date, time] = at.split("T");
  const folder = [prefix.replace(/^\/+|\/+$/g, ""), ...date.split("-")].filter(Boolean).join("/");
  return `${folder}/${time.replace(/:/g, "-")}-${random}.jsonl`;
}

/**
 * Files of JSON lines in any storage the CMS supports: `s3Storage(...)` from tansy/storage
 * for S3, R2, B2, MinIO and the rest, or a storage plugin's adapter. One file a write.
 */
export function storageDestination(adapter: StorageAdapter, options: { prefix?: string; name?: string; label?: string } = {}): RequestLogDestination {
  const prefix = options.prefix ?? "request-logs";
  return {
    name: options.name ?? "storage",
    label: options.label ?? `Storage (${adapter.name})`,
    async write(entries) {
      if (!entries.length) return;
      adapter.assertUsable?.();
      const bytes = new TextEncoder().encode(jsonLines(entries));
      const key = fileKey(prefix, entries[0].at, crypto.randomUUID().slice(0, 8));
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      await adapter.put(key, body, { size: bytes.byteLength, contentType: "application/x-ndjson" });
    },
  };
}

export interface HttpDestinationOptions {
  /** Where entries are POSTed, such as a log service's ingest URL. Must be https, except on localhost. */
  url: string;
  /** Such as an Authorization header with the service's token. Read it from an environment variable. */
  headers?: Record<string, string>;
  /** "ndjson", one entry a line, or "json", an array. "ndjson" when left out. */
  format?: "ndjson" | "json";
  name?: string;
  label?: string;
  /** Milliseconds. 10 seconds when left out. */
  timeoutMs?: number;
}

/** POSTs entries to a log service, such as Axiom, Better Stack, Datadog, Grafana Loki through a gateway, or your own endpoint. */
export function httpDestination(options: HttpDestinationOptions): RequestLogDestination {
  const url = new URL(options.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Request logs: an HTTP destination's url must use https.");
  const format = options.format ?? "ndjson";
  return {
    name: options.name ?? "http",
    label: options.label ?? url.host,
    async write(entries) {
      if (!entries.length) return;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": format === "json" ? "application/json" : "application/x-ndjson", ...options.headers },
        body: format === "json" ? JSON.stringify(entries) : jsonLines(entries),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`${url.host} answered ${response.status}.`);
    },
  };
}

/** One JSON line an entry on standard output, for a host that collects it, such as Vercel, Fly, Docker or Kubernetes. */
export function consoleDestination(options: { name?: string; label?: string } = {}): RequestLogDestination {
  return {
    name: options.name ?? "console",
    label: options.label ?? "Server output",
    async write(entries) {
      for (const entry of entries) console.log(JSON.stringify({ type: "request", ...entry }));
    },
  };
}
