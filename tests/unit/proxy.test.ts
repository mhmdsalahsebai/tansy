import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { createCmsProxy, type HostProxy } from "../../packages/cms/routes/proxy";

const event = {} as NextFetchEvent;
const request = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers: { "x-keep": "kept", "x-nonce": "from-client", ...(cookie ? { cookie } : {}), ...headers } });
const page = (path: string, cookie?: string) => request(path, cookie, { "sec-fetch-dest": "document" });
const forwarded = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);
const SESSION = "better-auth.session_token=abc";

function nonceOf(response: Response) {
  return /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];
}

describe("createCmsProxy", () => {
  it("sets headers and a fresh nonce with no host proxy", async () => {
    const response = await createCmsProxy({})(request("/about"), event);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(forwarded(response, "x-nonce")).toBe(nonceOf(response));
    expect(forwarded(response, "x-keep")).toBe("kept");
  });

  it("keeps a page out of shared caches, because its nonce belongs to one request", async () => {
    // The nonce is in the HTML and in the policy: another visitor served a stored copy would
    // get a nonce that doesn't match theirs, and every script on the page would be blocked.
    expect((await createCmsProxy({})(page("/about"), event)).headers.get("cache-control")).toBe("private, no-cache");
    expect((await createCmsProxy({})(page("/dashboard/users", SESSION), event)).headers.get("cache-control")).toBe("private, no-cache");
    // An older client that sends no sec-fetch-dest is read from what it accepts.
    expect((await createCmsProxy({})(request("/about", undefined, { accept: "text/html,*/*" }), event)).headers.get("cache-control")).toBe("private, no-cache");
  });

  it("leaves everything that isn't a page to its own cache policy", async () => {
    // An API answer, a file and the payload of a client-side navigation each set their own.
    for (const one of [page("/api/users"), request("/about"), request("/about", undefined, { "sec-fetch-dest": "empty", RSC: "1" }), request("/logo.png", undefined, { "sec-fetch-dest": "image" })]) {
      expect((await createCmsProxy({})(one, event)).headers.get("cache-control"), one.nextUrl.pathname).toBeNull();
    }
  });

  it("doesn't overwrite a cache policy the host's proxy chose", async () => {
    const host = vi.fn<HostProxy>(() => new NextResponse("ok", { headers: { "cache-control": "public, max-age=60" } }));
    const response = await createCmsProxy({}, { proxy: host })(page("/about"), event);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("never runs the host's proxy on the CMS's own paths", async () => {
    const host = vi.fn<HostProxy>(() => NextResponse.redirect("http://evil.example/"));
    const proxy = createCmsProxy({}, { proxy: host });
    for (const path of ["/api", "/api/users", "/dashboard/auth/signin"]) expect((await proxy(request(path), event)).status, path).toBe(200);
    expect((await proxy(request("/dashboard/users", SESSION), event)).status).toBe(200);
    expect((await proxy(request("/dashboard/users"), event)).headers.get("location")).toContain("/dashboard/auth/signin");
    expect(host).not.toHaveBeenCalled();
  });

  it("runs the host's proxy on paths that only look like the CMS's", async () => {
    const host = vi.fn<HostProxy>();
    await createCmsProxy({}, { proxy: host })(request("/dashboards"), event);
    await createCmsProxy({}, { proxy: host })(request("/apis"), event);
    expect(host).toHaveBeenCalledTimes(2);
  });

  it("carries on when the host's proxy returns nothing", async () => {
    const response = await createCmsProxy({}, { proxy: () => undefined })(request("/about"), event);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(forwarded(response, "x-nonce")).toBe(nonceOf(response));
  });

  it("forwards the nonce through a plain next() and the whole request with it", async () => {
    const response = await createCmsProxy({}, { proxy: () => NextResponse.next() })(request("/about"), event);
    expect(forwarded(response, "x-nonce")).toBe(nonceOf(response));
    expect(forwarded(response, "x-keep")).toBe("kept");
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).toEqual(expect.arrayContaining(["x-nonce", "x-pathname", "content-security-policy", "x-keep"]));
  });

  it("keeps request headers the host set, and doesn't let it choose the nonce", async () => {
    const proxy = createCmsProxy({}, { proxy: (incoming) => {
      const headers = new Headers(incoming.headers);
      headers.set("x-tenant", "acme");
      return NextResponse.next({ request: { headers } });
    } });
    const response = await proxy(request("/about"), event);
    expect(forwarded(response, "x-tenant")).toBe("acme");
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).toContain("x-tenant");
    expect(forwarded(response, "x-nonce")).toBe(nonceOf(response));
    expect(forwarded(response, "x-nonce")).not.toBe("from-client");
  });

  it("forwards through a rewrite", async () => {
    const response = await createCmsProxy({}, { proxy: () => NextResponse.rewrite("http://localhost/elsewhere") })(request("/about"), event);
    expect(response.headers.get("x-middleware-rewrite")).toBe("http://localhost/elsewhere");
    expect(forwarded(response, "x-nonce")).toBe(nonceOf(response));
  });

  it("puts security headers on the host's own responses, even read-only ones", async () => {
    const redirected = await createCmsProxy({}, { proxy: () => Response.redirect("http://localhost/moved", 307) })(request("/old"), event);
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("location")).toBe("http://localhost/moved");
    expect(redirected.headers.get("x-content-type-options")).toBe("nosniff");
    expect(forwarded(redirected, "x-nonce")).toBeNull();
    const body = await createCmsProxy({}, { proxy: () => new Response("hello", { status: 201 }) })(request("/made"), event);
    expect(body.status).toBe(201);
    expect(await body.text()).toBe("hello");
    expect(body.headers.get("content-security-policy")).toContain("default-src");
  });
});
