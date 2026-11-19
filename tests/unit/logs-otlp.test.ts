import { afterEach, describe, expect, it, vi } from "vitest";
import { createDenialFolder } from "@/core/audit/fold";
import { auditRecord, exportRequest, logsOtlp, logsUrl, otlpDestination, parseHeaders, requestRecord } from "../../plugins/logs-otlp/index";
import { resolveOptions } from "../../plugins/logs-otlp/otlp";

describe("folding repeated denials", () => {
  it("writes the first in a window, counts the rest, and hands the count to the next one written", () => {
    const fold = createDenialFolder(60_000);
    expect(fold("a", 0)).toEqual({ write: true, folded: 0 });
    expect(fold("a", 1_000)).toEqual({ write: false });
    expect(fold("a", 59_999)).toEqual({ write: false });
    expect(fold("b", 2_000)).toEqual({ write: true, folded: 0 });
    expect(fold("a", 60_000)).toEqual({ write: true, folded: 2 });
    expect(fold("a", 120_000)).toEqual({ write: true, folded: 0 });
  });

  it("forgets the oldest sources past its limit, so a spread-out flood can't grow it", () => {
    const fold = createDenialFolder(60_000, 3);
    for (const key of ["a", "b", "c", "d"]) fold(key, 0);
    // "a" was forgotten, so it's written whole; "d" is still remembered.
    expect(fold("a", 1)).toEqual({ write: true, folded: 0 });
    expect(fold("d", 1)).toEqual({ write: false });
  });
});

describe("OTLP encoding", () => {
  it("reads OpenTelemetry's variables in its own order and keeps keys out of the address", () => {
    expect(parseHeaders("authorization=Bearer%20abc, x-scope=tenant=1,broken")).toEqual({ authorization: "Bearer abc", "x-scope": "tenant=1" });
    expect(logsUrl({ base: "http://collector:4318/" })).toBe("http://collector:4318/v1/logs");
    expect(logsUrl({ full: "https://otlp.example/v1/logs" })).toBe("https://otlp.example/v1/logs");
    expect(() => logsUrl({ base: "https://user:pass@otlp.example" })).toThrow(/headers/);
    expect(() => logsUrl({ base: "ftp://otlp.example" })).toThrow(/https/);
    expect(() => logsUrl({})).toThrow(/endpoint/);
    const resolved = resolveOptions({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://b:4318/logs", OTEL_EXPORTER_OTLP_HEADERS: "k=v", OTEL_SERVICE_NAME: "site" });
    expect(resolved).toMatchObject({ url: "http://b:4318/logs", headers: { k: "v" }, serviceName: "site" });
    expect(resolveOptions({ endpoint: "http://c:4318" }, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://b:4318/logs" }).url).toBe("http://c:4318/v1/logs");
  });

  it("turns entries into log records with OpenTelemetry's attribute names", () => {
    const audit = auditRecord({ id: "1", at: "2026-11-20T10:00:00.000Z", action: "authz.denied", outcome: "denied", actorId: null, ipAddress: "9.9.9.9", scope: "acme", metadata: { path: "/api/x" } });
    expect(audit).toMatchObject({ timeUnixNano: "1795168800000000000", severityText: "WARN", eventName: "authz.denied" });
    expect(audit.attributes).toEqual(expect.arrayContaining([
      { key: "client.address", value: { stringValue: "9.9.9.9" } },
      { key: "tansy.scope", value: { stringValue: "acme" } },
      { key: "tansy.audit.metadata", value: { stringValue: "{\"path\":\"/api/x\"}" } },
    ]));
    expect(audit.attributes.some((attribute) => attribute.key === "enduser.id")).toBe(false);
    const request = requestRecord({ at: "2026-11-20T10:00:00.000Z", method: "POST", path: "/api/x", status: 503, durationMs: 12, actorId: "u1", ipAddress: null, userAgent: null });
    expect(request).toMatchObject({ severityText: "ERROR", body: { stringValue: "POST /api/x 503" } });
    expect(request.attributes).toContainEqual({ key: "http.response.status_code", value: { intValue: "503" } });
    expect(exportRequest("tansy", [request]).resourceLogs[0].resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "tansy" } }]);
  });
});

describe("logs-otlp plugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { cmsLogsOtlp?: unknown }).cmsLogsOtlp;
  });

  const ok = () => new Response(null, { status: 200 });
  const event = { action: "settings.update", outcome: "success" as const, actorId: "u1", metadata: { section: "general" } };

  it("batches audit events and posts them to the logs address, each with its own id", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ok());
    const plugin = logsOtlp({ endpoint: "http://collector:4318", headers: { authorization: "Bearer k" } }, fetcher as unknown as typeof fetch);
    plugin.auth!.onAudit!(event);
    plugin.auth!.onAudit!({ ...event, action: "user.create" });
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://collector:4318/v1/logs");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer k", "content-type": "application/json" } });
    const records = JSON.parse(String(init.body)).resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.map((record: { eventName: string }) => record.eventName)).toEqual(["settings.update", "user.create"]);
    const ids = records.map((record: { attributes: Array<{ key: string; value: { stringValue: string } }> }) => record.attributes.find((attribute) => attribute.key === "tansy.audit.id")!.value.stringValue);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps events while the backend is down and sends them, once, when it's back", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const plugin = logsOtlp({ endpoint: "http://collector:4318" }, fetcher as unknown as typeof fetch);
    plugin.auth!.onAudit!(event);
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    plugin.auth!.onAudit!({ ...event, action: "user.create" });
    fetcher.mockImplementation(async () => ok());
    // Waits out the backoff rather than trying again on the next event.
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const records = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body)).resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never reports what the backend said, which can quote the key", async () => {
    const destination = otlpDestination({ endpoint: "https://otlp.example" }, (async () => new Response("bad key sk_live_123", { status: 401 })) as unknown as typeof fetch);
    expect(destination).toMatchObject({ name: "otlp", label: "OpenTelemetry (otlp.example)" });
    const failure = destination.write([{ at: "2026-11-20T10:00:00.000Z", method: "GET", path: "/api/x", status: 200, durationMs: 1, actorId: null, ipAddress: null, userAgent: null }]);
    await expect(failure).rejects.toThrow("The OTLP endpoint answered 401.");
    await expect(failure).rejects.not.toThrow(/sk_live/);
  });
});
