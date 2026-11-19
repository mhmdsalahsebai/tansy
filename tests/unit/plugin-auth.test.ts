import { describe, expect, it, vi } from "vitest";
import type { AuthRuntime } from "@/core/auth/instance";
import { extensionAuth } from "@/core/extend/auth-call";
import { assertPluginManifest } from "@/core/extend/manifest";
import { definePlugin } from "@/core/extend/define";

/** A runtime whose better-auth API has one endpoint the acme plugin added and one it didn't. */
function runtime() {
  const own = vi.fn(async (input: unknown) => ({ ok: true, input }));
  const other = vi.fn(async () => ({ ok: true }));
  const value = {
    auth: { api: { acmePortal: own, signInEmail: other, otherPortal: other } },
    extensionEndpoints: new Map([["acme", new Map([["/acme/portal", "acmePortal"]])], ["other", new Map([["/other/portal", "otherPortal"]])]]),
  } as unknown as AuthRuntime;
  return { value, own, other };
}

describe("context.auth.call", () => {
  it("calls the plugin's own better-auth endpoint, with the caller's session and nothing else", async () => {
    const { value, own } = runtime();
    const headers = new Headers({ cookie: "session=abc", "user-agent": "test", "x-api-key": "key", authorization: "Bearer token", "x-forwarded-for": "203.0.113.4" });
    const result = await extensionAuth(value, "plugin:acme", headers).call<{ ok: boolean }>("/acme/portal", { body: { returnUrl: "https://example.com/" } });
    expect(result.ok).toBe(true);
    const input = own.mock.calls[0][0] as { headers: Headers; body: unknown };
    expect(input.body).toEqual({ returnUrl: "https://example.com/" });
    expect(input.headers.get("cookie")).toBe("session=abc");
    expect(input.headers.get("x-forwarded-for")).toBe("203.0.113.4");
    // An API key would let better-auth act as whoever it belongs to. With a key, the guard's caller is its owner, so a bearer token stays behind too.
    expect(input.headers.has("x-api-key")).toBe(false);
    expect(input.headers.has("authorization")).toBe(false);
  });

  it("passes on a bearer session token, the caller's own session from a headless site", async () => {
    const { value, own } = runtime();
    await extensionAuth(value, "plugin:acme", new Headers({ authorization: "Bearer abc.sig" })).call("/acme/portal");
    expect((own.mock.calls[0][0] as { headers: Headers }).headers.get("authorization")).toBe("Bearer abc.sig");
    // Any other scheme isn't a session.
    await extensionAuth(value, "plugin:acme", new Headers({ authorization: "Basic dXNlcjpwYXNz" })).call("/acme/portal");
    expect((own.mock.calls[1][0] as { headers: Headers }).headers.has("authorization")).toBe(false);
  });

  it("turns the endpoint's errors into the route's answer, hiding server failures", async () => {
    const { value } = runtime();
    const fail = (statusCode: number) => Object.assign(new Error("x"), { statusCode, body: { code: "CUSTOMER_NOT_FOUND", message: "No customer." } });
    const api = value.auth.api as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.acmePortal.mockRejectedValueOnce(fail(404));
    await expect(extensionAuth(value, "plugin:acme", new Headers()).call("/acme/portal")).rejects.toMatchObject({ status: 404, code: "CUSTOMER_NOT_FOUND", message: "No customer." });
    api.acmePortal.mockRejectedValueOnce(fail(500));
    await expect(extensionAuth(value, "plugin:acme", new Headers()).call("/acme/portal")).rejects.toMatchObject({ status: 502, code: "UPSTREAM_FAILED" });
    const plain = new Error("network");
    api.acmePortal.mockRejectedValueOnce(plain);
    await expect(extensionAuth(value, "plugin:acme", new Headers()).call("/acme/portal")).rejects.toBe(plain);
  });

  it("can't reach another plugin's endpoints, core's, or any from a hook file", async () => {
    const { value, other } = runtime();
    const auth = extensionAuth(value, "plugin:acme", new Headers());
    await expect(auth.call("/other/portal")).rejects.toThrow(/added no better-auth endpoint/);
    await expect(auth.call("/sign-in/email")).rejects.toThrow(/added no better-auth endpoint/);
    await expect(extensionAuth(value, "hooks:shop.ts", new Headers()).call("/acme/portal")).rejects.toThrow(/hook file/);
    expect(other).not.toHaveBeenCalled();
  });
});

describe("auth.serverOnlyPaths", () => {
  const plugin = (paths: unknown[]) => definePlugin({ name: "acme", version: "1.0.0", apiVersion: 1, auth: { serverOnlyPaths: paths as string[] } });

  it("takes better-auth paths", () => {
    expect(() => assertPluginManifest(plugin(["/acme/portal", "/acme/items/:id"]))).not.toThrow();
  });

  it("refuses anything else", () => {
    for (const bad of ["acme/portal", "/", "", "/acme portal", "https://evil.test/x", 7]) expect(() => assertPluginManifest(plugin([bad]))).toThrow(/serverOnlyPaths/);
  });
});
