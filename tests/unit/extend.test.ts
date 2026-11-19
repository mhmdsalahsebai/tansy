import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { cronMatches, dueJobs, lastMatch, parseCron } from "@/core/extend/cron";
import type { ExtensionRoute } from "@/core/extend/define";
import { assertJob, assertNoClashes, assertRoute, type Registrations } from "@/core/extend/registry";
import { matchRoute, routePathProblem } from "@/core/extend/routing";
import { guardedLookup, isBlockedAddress, webhookUrlProblem } from "@/core/extend/safe-http";
import { toTsType } from "@/core/schema/describe";
import { CmsError, createClient } from "@/sdk";

const at = (text: string) => new Date(`${text}Z`);

describe("cron", () => {
  it("handles lists, ranges, steps and UTC", () => {
    const cron = parseCron("*/15 3-4 * * 1,5");
    expect(cronMatches(cron, at("2026-11-09T03:30:00"))).toBe(true); // A Monday.
    expect(cronMatches(cron, at("2026-11-09T03:31:00"))).toBe(false);
    expect(cronMatches(cron, at("2026-11-10T03:30:00"))).toBe(false);
  });
  it("treats 7 as Sunday, and either restricted day field as enough", () => {
    expect(cronMatches(parseCron("0 0 * * 7"), at("2026-11-08T00:00:00"))).toBe(true);
    const both = parseCron("0 0 13 * 5");
    expect(cronMatches(both, at("2026-11-13T00:00:00"))).toBe(true);
    expect(cronMatches(both, at("2026-11-06T00:00:00"))).toBe(true);
    expect(cronMatches(both, at("2026-11-07T00:00:00"))).toBe(false);
  });
  it("refuses malformed expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "a * * * *", "5-1 * * * *", "*/0 * * * *", "* * * * 8"]) expect(() => parseCron(bad), bad).toThrow();
  });
  it("runs a job once per matching minute", () => {
    const job = { name: "a", cron: "* * * * *" };
    const now = at("2026-11-09T10:00:30");
    expect(dueJobs([job], new Map(), now)).toEqual([job]);
    expect(dueJobs([job], new Map([["a", at("2026-11-09T10:00:01")]]), now)).toEqual([]);
    expect(dueJobs([job], new Map([["a", at("2026-11-09T09:59:59")]]), now)).toEqual([job]);
  });

  it("runs a job that missed its time once, when a trigger comes by late", () => {
    const nightly = { name: "n", cron: "0 3 * * *" };
    const now = at("2026-11-09T10:17:00");
    // Last ran yesterday at 3: today's 3:00 went by, so it's due, once.
    expect(dueJobs([nightly], new Map([["n", at("2026-11-08T03:00:00")]]), now)).toEqual([nightly]);
    // Already ran today.
    expect(dueJobs([nightly], new Map([["n", at("2026-11-09T03:00:00")]]), now)).toEqual([]);
    // Never noted: it waits for its next time rather than running at once.
    expect(dueJobs([nightly], new Map(), now)).toEqual([]);
    // Missed for weeks: it runs once, for its latest time in the past week.
    expect(dueJobs([nightly], new Map([["n", at("2026-10-01T03:00:00")]]), now)).toEqual([nightly]);
    expect(lastMatch(parseCron("0 3 1 1 *"), now, 0)).toBeNull();
  });
});

describe("extension routes", () => {
  const handler = () => undefined;
  const route = (extra: object) => ({ method: "GET", path: "/x", access: "authenticated", handler, ...extra }) as unknown as ExtensionRoute;

  it("must declare a complete policy", () => {
    expect(() => assertRoute(route({}))).not.toThrow();
    expect(() => assertRoute(route({ access: undefined }))).toThrow(/access/);
    expect(() => assertRoute(route({ access: "rules" }))).toThrow(/access/);
    expect(() => assertRoute(route({ access: "public" }))).toThrow(/reason/);
    expect(() => assertRoute(route({ access: "permission", permission: "nope:nope" }))).toThrow(/permission/);
  });
  it("must audit writes unless public", () => {
    expect(() => assertRoute(route({ method: "POST" }))).toThrow(/audit/);
    expect(() => assertRoute(route({ method: "POST", access: "permission", permission: "record:read" }))).toThrow(/audit/);
    expect(() => assertRoute(route({ method: "POST", audit: "x.y" }))).not.toThrow();
  });
  it("can't use odd paths", () => {
    for (const bad of ["x", "/../x", "/a/./b", "/a//b", "/a b", `/${"a".repeat(300)}`]) expect(routePathProblem(bad), bad).not.toBeNull();
    expect(routePathProblem("/sitemap.xml")).toBeNull();
    expect(routePathProblem("/posts/:id")).toBeNull();
  });
  it("prefer literal segments and bind params", () => {
    const routes = [{ method: "GET", path: "/p/:id" }, { method: "GET", path: "/p/new" }, { method: "POST", path: "/p/:id" }];
    expect(matchRoute(routes, "GET", ["p", "new"])?.route.path).toBe("/p/new");
    expect(matchRoute(routes, "GET", ["p", "7"])?.params).toEqual({ id: "7" });
    expect(matchRoute(routes, "GET", ["p"])).toBeNull();
    expect(matchRoute(routes, "DELETE", ["p", "7"])).toBeNull();
  });
  it("jobs need a valid name and schedule", () => {
    expect(() => assertJob({ name: "ok.job", cron: "0 3 * * *", handler })).not.toThrow();
    expect(() => assertJob({ name: "bad name", cron: "0 3 * * *", handler })).toThrow();
    expect(() => assertJob({ name: "ok", cron: "nope", handler })).toThrow();
  });
});

describe("extension clashes", () => {
  const route = (path: string, method: ExtensionRoute["method"] = "GET") => ({ method, path, access: "authenticated", handler: () => null }) as ExtensionRoute;
  const group = (_source: string, parts: Partial<Registrations>): Registrations => ({ hooks: [], routes: [], jobs: [], ...parts });
  const routes = (source: string, ...paths: string[]) => group(source, { routes: paths.map((path) => ({ source, value: route(path) })) });

  it("refuse the same route from two places, whatever its parameters are called", () => {
    expect(() => assertNoClashes([routes("plugin:a", "/stats"), routes("plugin:b", "/stats")])).toThrow(/plugin:a and again by plugin:b/);
    expect(() => assertNoClashes([routes("plugin:a", "/posts/:id"), routes("plugin:b", "/posts/:slug")])).toThrow(/Route GET/);
  });

  it("allow different methods, and a literal beside a parameter", () => {
    expect(() => assertNoClashes([routes("plugin:a", "/posts/:id"), routes("plugin:b", "/posts/new"), group("plugin:c", { routes: [{ source: "plugin:c", value: route("/posts/:id", "POST") }] })])).not.toThrow();
  });

  it("refuse the same job or block name", () => {
    const job = (source: string) => group(source, { jobs: [{ source, value: { name: "nightly", cron: "0 3 * * *", handler: () => {} } }] });
    const block = (source: string) => group(source, { blocks: [{ source, value: { name: "faq" } }] });
    expect(() => assertNoClashes([job("plugin:a"), job("cms_hooks/x.ts")])).toThrow(/Job nightly/);
    expect(() => assertNoClashes([block("plugin:a"), block("plugin:b")])).toThrow(/Block faq/);
  });
});

describe("webhook targets", () => {
  it("blocks private, loopback, link-local and mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-ip"]) expect(isBlockedAddress(address), address).toBe(true);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isBlockedAddress(address), address).toBe(false);
  });
  it("refuses unsafe URLs when saved", () => {
    expect(webhookUrlProblem("https://example.com/hook", false)).toBeNull();
    for (const bad of ["http://example.com/hook", "ftp://example.com", "https://user:pw@example.com", "https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest", "https://localhost/x", "https://db.internal/x", "nonsense"]) expect(webhookUrlProblem(bad, false), bad).not.toBeNull();
  });
  it("refuses a connection when the name resolves privately, whatever was checked earlier", async () => {
    const server = http.createServer((_, res) => res.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let reached = true;
    const error = await new Promise<Error>((resolve) => {
      const request = http.request({ host: "localhost", port: (server.address() as AddressInfo).port, lookup: guardedLookup as never }, () => resolve(new Error("connected")));
      request.on("error", (e) => { reached = false; resolve(e); });
      request.end();
    });
    await new Promise((resolve) => server.close(resolve));
    expect(reached).toBe(false);
    expect(error.message).toMatch(/private address/);
  });
  it("allows private targets only when the operator opts in", () => {
    expect(webhookUrlProblem("http://127.0.0.1:9000/x", true)).toBeNull();
  });
});

describe("generated types", () => {
  it("map JSON Schema to TypeScript", () => {
    expect(toTsType({ type: "string" })).toBe("string");
    expect(toTsType({ enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(toTsType({ type: "array", items: { type: "integer" } })).toBe("Array<number>");
    expect(toTsType({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
    expect(toTsType({ type: "object", required: ["a"], properties: { a: { type: "boolean" }, b: { type: "number" } } })).toBe('{ "a": boolean; "b"?: number }');
    expect(toTsType({})).toBe("unknown");
  });
});

describe("SDK", () => {
  interface Post { id: number; title: string; status: string; createdAt: string; updatedAt: string; publishedAt: string | null; createdById: string | null }
  type Collections = { posts: Post };
  const fake = (status: number, body: unknown) => vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it("builds record URLs and sends the API key", async () => {
    const fetcher = fake(200, { items: [] });
    const cms = createClient<Collections>({ url: "https://cms.test/", apiKey: "k", fetch: fetcher });
    await cms.collection("posts").list({ filter: 'a = "b"', perPage: 5 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cms.test/api/collections/posts/records?filter=a+%3D+%22b%22&perPage=5");
    expect(init.headers).toEqual({ "x-api-key": "k" });
  });
  it("sends writes as JSON, and handles 204", async () => {
    const fetcher = fake(204, null);
    const cms = createClient<Collections>({ fetch: fetcher });
    await expect(cms.collection("posts").delete(3)).resolves.toBeUndefined();
    await cms.collection("posts").update(3, { title: "x" });
    const [, init] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"title":"x"}');
  });
  it("turns error bodies into CmsError", async () => {
    const cms = createClient<Collections>({ fetch: fake(400, { error: { code: "VALIDATION_FAILED", message: "No", details: [{ path: "title" }] } }) });
    const error = await cms.collection("posts").create({ title: "" }).catch((e: unknown) => e) as CmsError;
    expect(error).toBeInstanceOf(CmsError);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.status).toBe(400);
  });
  it("builds file URLs", () => {
    expect(createClient({ url: "https://cms.test" }).fileUrl("a b", "300x300")).toBe("https://cms.test/api/files/a%20b?thumb=300x300");
  });
});
