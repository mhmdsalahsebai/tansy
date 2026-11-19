/** One logged request, as stored and as sent to destinations. */
export interface RequestLogEntry {
  /** ISO 8601, in UTC. */
  at: string;
  method: string;
  /** The path only. The query string can carry tokens, so it is never kept. */
  path: string;
  status: number;
  durationMs: number;
  actorId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export const WHICH = ["all", "writes", "errors"] as const;
export type Which = (typeof WHICH)[number];

/** "writes" keeps everything but reads that succeeded, "errors" only answers of 400 and up. */
export function kept(which: Which, entry: Pick<RequestLogEntry, "method" | "status">): boolean {
  if (which === "errors") return entry.status >= 400;
  if (which === "writes") return entry.status >= 400 || !["GET", "HEAD", "OPTIONS"].includes(entry.method);
  return true;
}

export const BATCH_PREFIX = "b:";
/** A few hundred entries: well under the store's 256 KiB a value, and a page the dashboard can show at once. */
export const MAX_BATCH_BYTES = 64 * 1024;

/** Keys sort by time, so the newest batch is the highest key. */
export const batchKey = (firstAt: string, suffix: string) => `${BATCH_PREFIX}${firstAt}:${suffix}`;

/** Every key of a batch older than this many days sorts below the result. */
export const cutoffKey = (days: number, now = Date.now()) => `${BATCH_PREFIX}${new Date(now - days * 86_400_000).toISOString()}`;

/** Splits entries into batches that each fit in one stored value. */
export function toBatches(entries: RequestLogEntry[], maxBytes = MAX_BATCH_BYTES): RequestLogEntry[][] {
  const batches: RequestLogEntry[][] = [];
  let current: RequestLogEntry[] = [];
  let size = 2;
  for (const entry of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (current.length && size + bytes > maxBytes) {
      batches.push(current);
      current = [];
      size = 2;
    }
    current.push(entry);
    size += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** A stored batch, read defensively: anything that isn't an entry is skipped. */
export function readBatch(value: unknown): RequestLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RequestLogEntry =>
    typeof entry === "object" && entry !== null && typeof entry.at === "string" && typeof entry.method === "string" && typeof entry.path === "string" && typeof entry.status === "number");
}

export interface EntryFilter {
  method?: string;
  path?: string;
  status?: "2xx" | "3xx" | "4xx" | "5xx";
}

export function matches(entry: RequestLogEntry, { method, path, status }: EntryFilter): boolean {
  if (method && entry.method !== method) return false;
  if (path && !entry.path.toLowerCase().includes(path.toLowerCase())) return false;
  if (status) {
    const floor = Number(status[0]) * 100;
    if (entry.status < floor || entry.status >= floor + 100) return false;
  }
  return true;
}

export type LoggedEntry = RequestLogEntry & { id: string };

/**
 * Reads batches newest first, from below `before` when given, until `perPage` entries match
 * or `maxBatches` batches have been read. `next` continues from where it stopped, null at
 * the oldest. `readPage` lists batches below a key, newest first.
 */
export async function findEntries(
  readPage: (before: string | undefined, limit: number) => Promise<Array<{ key: string; value: unknown }>>,
  filter: EntryFilter,
  { before, perPage = 50, maxBatches = 200, pageSize = 20 }: { before?: string; perPage?: number; maxBatches?: number; pageSize?: number } = {},
): Promise<{ items: LoggedEntry[]; next: string | null }> {
  const items: LoggedEntry[] = [];
  let cursor = before;
  let read = 0;
  while (read < maxBatches) {
    const limit = Math.min(pageSize, maxBatches - read);
    const batches = await readPage(cursor, limit);
    for (const [index, { key, value }] of batches.entries()) {
      readBatch(value).forEach((entry, position) => { if (matches(entry, filter)) items.push({ ...entry, id: `${key}#${position}` }); });
      cursor = key;
      read += 1;
      const more = index < batches.length - 1 || batches.length === limit;
      if (items.length >= perPage) return { items: newestFirst(items), next: more ? cursor : null };
    }
    if (batches.length < limit) return { items: newestFirst(items), next: null };
  }
  return { items: newestFirst(items), next: cursor ?? null };
}

const newestFirst = (items: LoggedEntry[]) => items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/** The paths never logged, as written in the settings: one prefix a line. */
export function skipList(text: unknown): string[] {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("/"));
}
