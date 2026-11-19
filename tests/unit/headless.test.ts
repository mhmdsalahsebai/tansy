import { describe, expect, it, vi } from "vitest";
import type { AuthRuntime } from "@/core/auth/instance";
import { authSettingsSchema } from "@/core/auth/settings-schema";
import { corsOrigin, preflight, withCors } from "@/core/http/cors";
import { CmsClient } from "@/sdk/index";

const user = { kind: "user", user: { id: "u1", email: "m@example.test" }, session: { id: "s1", createdAt: new Date(), impersonatedBy: null }, permissions: new Set(["dashboard:access", "record:read"]), custom: { plan: "pro" } };
const keyHolder = { kind: "apiKey", user: { id: "u2" }, keyId: "k1", permissions: new Set(["record:read"]) };

vi.mock("@/core/authz/principal", async (original) => ({
  ...(await original<typeof import("@/core/authz/principal")>()),
  principalFromSession: vi.fn(async (headers: Headers) => (headers.has("cookie") || headers.has("authorization") ? user : { kind: "anonymous", permissions: new Set() })),
  principalFromApiKey: vi.fn(async () => keyHolder),
}));

const { resolvePrincipal } = await import("@/core/authz/guard");

const settings = authSettingsSchema.parse({});
settings.network.trustedOrigins = ["https://site.example.com", "https://*.preview.example.com"];
const runtime = { settings } as unknown as AuthRuntime;
const request = (headers: Record<string, string>) => new Request("http://localhost:3000/api/collections/posts/records", { headers });

describe("CORS", () => {
  it("answers only trusted origins other than this app's own", () => {
    expect(corsOrigin(new Headers({ origin: "https://site.example.com" }), settings)).toBe("https://site.example.com");
    expect(corsOrigin(new Headers({ origin: "https://pr-4.preview.example.com" }), settings)).toBe("https://pr-4.preview.example.com");
    for (const origin of ["https://evil.test", "https://site.example.com.evil.test", "null", "http://localhost:3000"]) {
      expect(corsOrigin(new Headers({ origin }), settings), origin).toBeNull();
    }
    expect(corsOrigin(new Headers(), settings)).toBeNull();
  });

  it("lets a trusted origin read the answer and the session token, keeping headers better-auth exposed", () => {
    const answer = new Response("{}", { status: 200, headers: { "access-control-expose-headers": "x-own", "content-type": "application/json" } });
    const response = withCors(answer, request({ origin: "https://site.example.com" }), settings);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://site.example.com");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-expose-headers")).toBe("x-own, set-auth-token, content-disposition");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("gives any other origin nothing to read, and still varies by origin", () => {
    const response = withCors(new Response("{}"), request({ origin: "https://evil.test" }), settings);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("works on responses with read-only headers, such as redirects", () => {
    const response = withCors(Response.redirect("https://bucket.example.com/file", 302), request({ origin: "https://site.example.com" }), settings);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://bucket.example.com/file");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://site.example.com");
  });

  it("answers a preflight from a trusted origin only", () => {
    const trusted = preflight(request({ origin: "https://site.example.com", "access-control-request-headers": "authorization, content-type, x-cms-as" }), settings, "GET, POST, OPTIONS");
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-origin")).toBe("https://site.example.com");
    expect(trusted.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-cms-as");
    expect(trusted.headers.get("access-control-allow-methods")).toContain("PATCH");
    const other = preflight(request({ origin: "https://evil.test", "access-control-request-headers": "authorization" }), settings, "GET, OPTIONS");
    expect(other.headers.has("access-control-allow-origin")).toBe(false);
    expect(other.headers.has("access-control-allow-headers")).toBe(false);
  });
});

describe("reading as a member over HTTP", () => {
  it("keeps who the person is and drops every permission of their role", async () => {
    const member = await resolvePrincipal(request({ authorization: "Bearer t.sig", "x-cms-as": "member" }), runtime, false);
    expect(member.kind).toBe("user");
    expect(member.permissions.size).toBe(0);
    expect(member.custom).toEqual({ plan: "pro" });
    expect((await resolvePrincipal(request({ cookie: "s=1" }), runtime, false)).permissions.has("dashboard:access")).toBe(true);
  });

  it("leaves a signed-out caller a visitor", async () => {
    expect((await resolvePrincipal(request({ "x-cms-as": "member" }), runtime, false)).kind).toBe("anonymous");
  });

  it("refuses an API key, and any other value", async () => {
    await expect(resolvePrincipal(request({ "x-api-key": "cms_x", "x-cms-as": "member" }), runtime, true)).rejects.toMatchObject({ status: 400, code: "MEMBER_NEEDS_SESSION" });
    await expect(resolvePrincipal(request({ cookie: "s=1", "x-cms-as": "admin" }), runtime, false)).rejects.toMatchObject({ status: 400 });
  });
});

describe("SDK sessions", () => {
  const recording = (respond: (url: string, init: RequestInit) => Response = () => Response.json({ page: 1, perPage: 0, totalItems: 0, totalPages: 0, items: [] })) => {
    const calls: Array<{ url: string; init: RequestInit; headers: Record<string, string> }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init, headers: init.headers as Record<string, string> });
      return respond(String(url), init);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it("keeps the token sign-in returns, and tells the site", async () => {
    const onToken = vi.fn();
    const { calls, fetch } = recording(() => Response.json({ token: "raw", user: { id: "u1" } }, { headers: { "set-auth-token": "raw.sig" } }));
    const cms = new CmsClient({ url: "https://cms.example.com", fetch, onToken });
    await cms.auth.signIn.email({ email: "m@example.test", password: "pw" });
    expect(calls[0].url).toBe("https://cms.example.com/api/auth/sign-in/email");
    expect(cms.token).toBe("raw.sig");
    expect(onToken).toHaveBeenCalledWith("raw.sig");
    await cms.collection("posts").list();
    expect(calls[1].headers.authorization).toBe("Bearer raw.sig");
  });

  it("forgets the token on sign-out", async () => {
    const onToken = vi.fn();
    const { calls, fetch } = recording(() => Response.json({ success: true }));
    const cms = new CmsClient({ fetch, token: "t.sig", onToken });
    await cms.auth.signOut();
    expect(calls[0].headers.authorization).toBe("Bearer t.sig");
    expect(cms.token).toBeNull();
    expect(onToken).toHaveBeenCalledWith(null);
  });

  it("reports better-auth's errors as CmsError", async () => {
    const { fetch } = recording(() => Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, { status: 401 }));
    await expect(new CmsClient({ fetch }).auth.signIn.email({ email: "a@b.c", password: "x" })).rejects.toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  it("reads pages as a visitor, so they can be cached, and viewer() as the member", async () => {
    const { calls, fetch } = recording();
    const reader = new CmsClient({ fetch, token: "t.sig", apiKey: "cms_visitor" }).reader({ tags: ["cms"] });
    await reader.list("posts");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers["x-api-key"]).toBe("cms_visitor");
    expect((calls[0].init as { next?: unknown }).next).toEqual({ tags: ["cms"], revalidate: undefined });

    const member = await reader.viewer!();
    await member!.list("progress");
    expect(calls[1].headers.authorization).toBe("Bearer t.sig");
    expect(calls[1].headers["x-cms-as"]).toBe("member");
    // A member is a person: no API key, and nothing cached.
    expect(calls[1].headers["x-api-key"]).toBeUndefined();
    expect((calls[1].init as { next?: unknown }).next).toBeUndefined();
  });

  it("has no viewer() without a session", async () => {
    const { fetch } = recording();
    expect(await new CmsClient({ fetch }).reader().viewer!()).toBeNull();
  });

  it("sends cookies only when asked, and never with a visitor's read", async () => {
    const { calls, fetch } = recording();
    const cms = new CmsClient({ fetch, credentials: "include" });
    await cms.collection("posts").list();
    expect(calls[0].init.credentials).toBe("include");
    await cms.reader().list("posts");
    expect(calls[1].init.credentials).toBe("same-origin");
    await (await cms.reader().viewer!())!.list("progress");
    expect(calls[2].init.credentials).toBe("include");
  });
});
