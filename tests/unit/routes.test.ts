import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createMatcher } from "../../packages/cms/routes/match";

const table = ["users", "users/[id]", "users/[id]/role", "users/me", "auth/[...all]", "docs/[[...slug]]", "[...any]"].map((pattern) => ({ pattern }));
const match = createMatcher(table);
const hit = (path: string) => { const found = match(path.split("/")); return found && [found.entry.pattern, found.params]; };

describe("route matching", () => {
  it("prefers a fixed name over a parameter, and a parameter over a catch-all", () => {
    expect(hit("users/me")).toEqual(["users/me", {}]);
    expect(hit("users/42")).toEqual(["users/[id]", { id: "42" }]);
    expect(hit("users/42/role")).toEqual(["users/[id]/role", { id: "42" }]);
    expect(hit("users/42/other")).toEqual(["[...any]", { any: ["users", "42", "other"] }]);
  });

  it("collects the rest of the path, and lets an optional catch-all be empty", () => {
    expect(hit("auth/sign-in/email")).toEqual(["auth/[...all]", { all: ["sign-in", "email"] }]);
    expect(hit("docs")).toEqual(["docs/[[...slug]]", {}]);
    expect(hit("docs/a/b")).toEqual(["docs/[[...slug]]", { slug: ["a", "b"] }]);
  });

  it("keeps an encoded slash inside one segment, so it can't reach another route", () => {
    expect(match(["users", "1/role"])).toEqual({ entry: { pattern: "users/[id]" }, params: { id: "1/role" } });
  });

  it("finds nothing when no pattern fits", () => {
    expect(createMatcher([{ pattern: "a" }])(["b"])).toBeNull();
    expect(createMatcher([{ pattern: "a/[id]" }])(["a"])).toBeNull();
  });
});

describe("API dispatcher", () => {
  const request = (method: string) => new Request("http://x/api/test", { method }) as NextRequest;
  const context = { params: Promise.resolve({ cms: ["test"] }) };

  async function handlers(module: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("../../packages/cms/routes/api-table.generated", () => ({ apiRoutes: [{ pattern: "test", load: async () => module }] }));
    const { createApiHandlers } = await import("../../packages/cms/routes/api");
    return createApiHandlers({});
  }

  it("refuses a handler that isn't wrapped in route()", async () => {
    const { POST } = await handlers({ POST: async () => new Response("open") });
    await expect(POST(request("POST"), context)).rejects.toThrow(/not wrapped in route/);
  });

  it("answers an unknown path with 404", async () => {
    const { GET } = await handlers({});
    expect((await GET(request("GET"), { params: Promise.resolve({ cms: ["nope"] }) })).status).toBe(404);
  });

  it("does what Next.js does for missing methods, HEAD and OPTIONS", async () => {
    vi.resetModules();
    const { ROUTE_POLICY } = await import("@/core/authz/guard");
    const GET = Object.assign(async () => new Response("body", { status: 201 }), { [ROUTE_POLICY]: { access: "authenticated" } });
    vi.doMock("../../packages/cms/routes/api-table.generated", () => ({ apiRoutes: [{ pattern: "test", load: async () => ({ GET }) }] }));
    const { createApiHandlers } = await import("../../packages/cms/routes/api");
    const api = createApiHandlers({});
    const missing = await api.DELETE(request("DELETE"), context);
    expect([missing.status, missing.headers.get("allow")]).toEqual([405, "GET, HEAD, OPTIONS"]);
    const head = await api.HEAD(request("HEAD"), context);
    expect([head.status, await head.text()]).toEqual([201, ""]);
    expect((await api.OPTIONS(request("OPTIONS"), context)).status).toBe(204);
  });
});
