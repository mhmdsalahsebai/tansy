import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, PluginStore } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { requestLogs } from "../../plugins/request-logs/index";
import { fileKey, httpDestination, jsonLines, storageDestination } from "../../plugins/request-logs/destinations";
import { batchKey, cutoffKey, findEntries, kept, toBatches, type RequestLogEntry } from "../../plugins/request-logs/logic";

const entry = (at: string, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry => ({ at, method: "GET", path: "/api/things", status: 200, durationMs: 3, actorId: null, ipAddress: "1.2.3.4", userAgent: "ua", ...overrides });

function memoryStore(): PluginStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const sorted = (prefix: string) => [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, structuredClone(value)); },
    claim: async (key, value) => (data.has(key) ? false : (data.set(key, value), true)),
    delete: async (key) => { data.delete(key); },
    list: async (prefix = "", { before, order = "asc", limit } = {}) => {
      let keys = sorted(prefix).filter((key) => before === undefined || key < before);
      if (order === "desc") keys = keys.reverse();
      return keys.slice(0, limit ?? keys.length).map((key) => ({ key, value: data.get(key) }));
    },
    deleteMany: async (prefix, { before } = {}) => {
      const gone = sorted(prefix).filter((key) => before === undefined || key < before);
      gone.forEach((key) => data.delete(key));
      return gone.length;
    },
  };
}

describe("request logs", () => {
  it("is a valid plugin, and refuses a destination listed twice", () => {
    expect(() => assertPluginManifest(requestLogs())).not.toThrow();
    const drain = { name: "drain", label: "Drain", write: async () => undefined };
    expect(() => requestLogs({ destinations: [drain, drain] })).toThrow(/twice/);
  });

  it("keeps what each setting asks for", () => {
    expect(kept("all", { method: "GET", status: 200 })).toBe(true);
    expect(kept("writes", { method: "GET", status: 200 })).toBe(false);
    expect(kept("writes", { method: "POST", status: 201 })).toBe(true);
    expect(kept("writes", { method: "GET", status: 404 })).toBe(true);
    expect(kept("errors", { method: "POST", status: 201 })).toBe(false);
    expect(kept("errors", { method: "GET", status: 500 })).toBe(true);
  });

  it("splits entries into batches that fit one stored value", () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`2026-11-16T10:00:${String(i % 60).padStart(2, "0")}.000Z`));
    const batches = toBatches(many, 4096);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(300);
    for (const batch of batches) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(4096);
  });

  it("pages newest first through batches, filtered, and stops at the oldest", async () => {
    const store = memoryStore();
    for (let minute = 0; minute < 10; minute++) {
      const at = `2026-11-16T10:0${minute}:00.000Z`;
      await store.set(batchKey(at, "a"), [entry(at), entry(at, { method: "POST", status: 500 })]);
    }
    const read = (before: string | undefined, limit: number) => store.list("b:", { before, order: "desc", limit });
    const first = await findEntries(read, {}, { perPage: 6, pageSize: 2 });
    expect(first.items).toHaveLength(6);
    expect(first.items[0].at).toBe("2026-11-16T10:09:00.000Z");
    const second = await findEntries(read, {}, { before: first.next!, perPage: 100, pageSize: 3 });
    expect(second.items).toHaveLength(14);
    expect(second.next).toBeNull();
    const errors = await findEntries(read, { status: "5xx" }, { perPage: 100 });
    expect(errors.items.every((item) => item.status === 500)).toBe(true);
    expect(errors.items).toHaveLength(10);
  });

  it("deletes batches older than the retention without touching newer ones", async () => {
    const store = memoryStore();
    const now = Date.parse("2026-11-16T12:00:00.000Z");
    await store.set(batchKey("2026-11-01T00:00:00.000Z", "a"), []);
    await store.set(batchKey("2026-11-15T00:00:00.000Z", "b"), []);
    await store.set("other", 1);
    expect(await store.deleteMany("b:", { before: cutoffKey(7, now) })).toBe(1);
    expect([...store.data.keys()].sort()).toEqual([batchKey("2026-11-15T00:00:00.000Z", "b"), "other"]);
  });

  it("writes JSON-line files to storage, by day", async () => {
    const put = vi.fn(async (_key: string, body: ReadableStream<Uint8Array>, _options?: { contentType?: string }) => { await new Response(body).text(); });
    const destination = storageDestination({ name: "s3", put, get: async () => null, delete: async () => undefined } as never, { prefix: "logs/" });
    await destination.write([entry("2026-11-16T10:20:30.123Z"), entry("2026-11-16T10:20:31.000Z")]);
    expect(put.mock.calls[0][0]).toMatch(/^logs\/2026\/11\/16\/10-20-30\.123Z-[0-9a-f]{8}\.jsonl$/);
    expect(put.mock.calls[0][2]).toMatchObject({ contentType: "application/x-ndjson" });
    expect(fileKey("", "2026-01-02T03:04:05.000Z", "x")).toBe("2026/01/02/03-04-05.000Z-x.jsonl");
    expect(jsonLines([entry("t")]).trim().split("\n")).toHaveLength(1);
  });

  it("refuses an HTTP destination that isn't https", () => {
    expect(() => httpDestination({ url: "http://logs.example.com" })).toThrow(/https/);
    expect(() => httpDestination({ url: "http://localhost:9000/in" })).not.toThrow();
  });

  it("queues requests and writes them to the store and every destination, minus its own and skipped paths", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const write = vi.fn(async () => undefined);
      const plugin = requestLogs({ destinations: [{ name: "drain", label: "Drain", write }] });
      const context = { store, settings: { get: async () => ({ storeIp: false }) } } as unknown as ExtensionContext;
      const at = new Date("2026-11-16T10:00:00.000Z");
      const request = { at, method: "GET", status: 200, durationMs: 1, actorId: null, ipAddress: "9.9.9.9", userAgent: "ua" };
      plugin.onRequest!({ ...request, path: "/api/things" }, context);
      plugin.onRequest!({ ...request, path: "/api/realtime/stream" }, context);
      plugin.onRequest!({ ...request, path: "/api/ext/request-logs/entries" }, context);
      await vi.advanceTimersByTimeAsync(2500);
      const stored = [...store.data.values()].flat() as RequestLogEntry[];
      expect(stored).toEqual([expect.objectContaining({ path: "/api/things", ipAddress: null, userAgent: null })]);
      expect(write).toHaveBeenCalledWith([expect.objectContaining({ path: "/api/things" })]);
    } finally {
      vi.useRealTimers();
      delete (globalThis as { cmsRequestLogs?: unknown }).cmsRequestLogs;
    }
  });

  it("keeps IP addresses and browsers under separate switches", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const plugin = requestLogs();
      const context = { store, settings: { get: async () => ({ storeIp: true, storeUserAgent: false }) } } as unknown as ExtensionContext;
      plugin.onRequest!({ at: new Date("2026-11-16T10:00:00.000Z"), method: "POST", path: "/api/things", status: 201, durationMs: 1, actorId: null, ipAddress: "9.9.9.9", userAgent: "ua" }, context);
      await vi.advanceTimersByTimeAsync(2500);
      expect([...store.data.values()].flat()).toEqual([expect.objectContaining({ ipAddress: "9.9.9.9", userAgent: null })]);
    } finally {
      vi.useRealTimers();
      delete (globalThis as { cmsRequestLogs?: unknown }).cmsRequestLogs;
    }
  });
});
