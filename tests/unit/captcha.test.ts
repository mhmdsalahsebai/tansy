import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { provideCmsConfig } from "@/core/config";
import { defineCms } from "@/core/auth/extensions";
import { authCaptcha, checkAuthRequest, extensionCaptcha } from "@/core/captcha";
import type { CaptchaAdapter } from "@/core/captcha/types";
import { captcha } from "../../plugins/captcha/index";
import { siteVerify, type CaptchaProvider } from "../../plugins/captcha/provider";
import { hcaptcha } from "../../plugins/captcha-hcaptcha/index";
import { recaptcha } from "../../plugins/captcha-recaptcha/index";
import { turnstile } from "../../plugins/captcha-turnstile/index";

vi.mock("@/core/extend/hooks", () => ({ extensionContext: (source: string) => contexts.get(source) }));
const contexts = new Map<string, ExtensionContext>();

const contextWith = (values: Record<string, unknown>) => ({ settings: { get: async () => values } }) as unknown as ExtensionContext;

/** A fetch that records what it was called with and answers `answer`. */
function recordingFetch(answer: () => Response) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return answer();
  }) as typeof fetch;
  return { calls, fetcher };
}

const ok = (success: boolean) => () => new Response(JSON.stringify({ success, hostname: "example.com" }), { headers: { "content-type": "application/json" } });

describe("CAPTCHA plugin", () => {
  it("validates its options and its providers' setting names", () => {
    expect(() => captcha({ providers: [] })).toThrow(/at least one provider/);
    expect(() => captcha({ providers: [turnstile(), turnstile()] })).toThrow(/listed twice/);
    expect(() => captcha({ providers: [turnstile()], provider: "hcaptcha" })).toThrow(/isn't one of the providers/);
    const sloppy = { ...turnstile(), settings: () => [{ name: "secret", type: "secret" as const, label: "Secret" }] } as CaptchaProvider;
    expect(() => captcha({ providers: [sloppy] })).toThrow(/must start with "turnstile"/);
    expect(() => assertPluginManifest(captcha({ providers: [turnstile(), hcaptcha(), recaptcha()] }))).not.toThrow();
  });

  it("keeps every provider's secret a secret, and adds only their exact origins to the CSP", () => {
    const plugin = captcha({ providers: [turnstile(), hcaptcha(), recaptcha()] });
    const secrets = plugin.settings!.fields.filter((field) => /secret/i.test(field.name));
    expect(secrets.map((field) => field.type)).toEqual(["secret", "secret", "secret"]);
    expect(plugin.csp?.frame).toEqual(expect.arrayContaining(["https://challenges.cloudflare.com", "https://newassets.hcaptcha.com", "https://www.google.com"]));
    expect(JSON.stringify(plugin.csp)).not.toContain("*");
  });

  it("is ready only once the chosen provider's site key and secret are set", async () => {
    const adapter = captcha({ providers: [turnstile()] }).auth!.captcha!;
    expect(await adapter.ready!(contextWith({ provider: "turnstile", turnstileSiteKey: "site", turnstileSecretKey: "" }))).toBe(false);
    expect(await adapter.ready!(contextWith({ provider: "turnstile", turnstileSiteKey: "", turnstileSecretKey: "secret" }))).toBe(false);
    expect(await adapter.ready!(contextWith({ provider: "gone", turnstileSiteKey: "site", turnstileSecretKey: "secret" }))).toBe(false);
    expect(await adapter.ready!(contextWith({ provider: "turnstile", turnstileSiteKey: "site", turnstileSecretKey: "secret" }))).toBe(true);
  });

  it("gives the browser the site key and never the secret", async () => {
    const adapter = captcha({ providers: [hcaptcha()] }).auth!.captcha!;
    const widget = await adapter.widget(contextWith({ provider: "hcaptcha", hcaptchaSiteKey: "site-key", hcaptchaSecret: "very-secret" }));
    expect(widget).toEqual({ provider: "hcaptcha", script: "https://js.hcaptcha.com/1/api.js?render=explicit", global: "hcaptcha", siteKey: "site-key" });
    expect(JSON.stringify(widget)).not.toContain("very-secret");
  });

  it("asks on the sign-in forms its settings name", async () => {
    const plugin = captcha({ providers: [turnstile()], authForms: ["signup"] });
    const field = (name: string) => plugin.settings!.fields.find((item) => item.name === name)!.default;
    expect([field("signIn"), field("signUp"), field("passwordReset")]).toEqual([false, true, false]);
    expect(await plugin.auth!.captcha!.authForms!(contextWith({ signIn: true, signUp: false, passwordReset: true }))).toEqual(["signin", "forgot-password"]);
  });
});

describe("CAPTCHA provider adapters", () => {
  it.each([
    ["Turnstile", (fetcher: typeof fetch) => turnstile({ fetcher }), { turnstileSiteKey: "site", turnstileSecretKey: "secret" }, "https://challenges.cloudflare.com/turnstile/v0/siteverify"],
    ["hCaptcha", (fetcher: typeof fetch) => hcaptcha({ fetcher }), { hcaptchaSiteKey: "site", hcaptchaSecret: "secret" }, "https://api.hcaptcha.com/siteverify"],
    ["reCAPTCHA", (fetcher: typeof fetch) => recaptcha({ fetcher }), { recaptchaSiteKey: "site", recaptchaSecretKey: "secret" }, "https://www.google.com/recaptcha/api/siteverify"],
  ])("%s posts the secret, answer and address to its siteverify", async (_, make, keys, url) => {
    const { calls, fetcher } = recordingFetch(ok(true));
    const provider = make(fetcher);
    expect(await provider.verify("answer-1", { ip: "203.0.113.9" }, { provider: provider.id, signIn: false, signUp: false, passwordReset: false, ...keys })).toBe(true);
    expect(calls[0].url).toBe(url);
    const sent = new URLSearchParams(calls[0].body);
    expect([sent.get("secret"), sent.get("response"), sent.get("remoteip")]).toEqual(["secret", "answer-1", "203.0.113.9"]);
  });

  it("refuses on an error status, a redirect, a timeout or an answer that isn't JSON", async () => {
    expect(await siteVerify("https://verify.example/", { secret: "s", response: "a" }, recordingFetch(ok(false)).fetcher)).toBe(false);
    expect(await siteVerify("https://verify.example/", { secret: "s", response: "a" }, recordingFetch(() => new Response("nope", { status: 500 })).fetcher)).toBe(false);
    expect(await siteVerify("https://verify.example/", { secret: "s", response: "a" }, recordingFetch(() => new Response("<html>")).fetcher)).toBe(false);
    expect(await siteVerify("https://verify.example/", { secret: "s", response: "a" }, (async () => { throw new TypeError("redirect"); }) as typeof fetch)).toBe(false);
    // `success` must be exactly true.
    expect(await siteVerify("https://verify.example/", { secret: "s", response: "a" }, recordingFetch(() => new Response(JSON.stringify({ success: "true" }))).fetcher)).toBe(false);
  });

  it("leaves out an unknown address rather than sending an empty one", async () => {
    const { calls, fetcher } = recordingFetch(ok(true));
    await siteVerify("https://verify.example/", { secret: "s", response: "a", remoteip: null }, fetcher);
    expect(new URLSearchParams(calls[0].body).has("remoteip")).toBe(false);
  });
});

describe("core CAPTCHA", () => {
  function install(adapter: Partial<CaptchaAdapter>, name = "guard") {
    contexts.set(`plugin:${name}`, { marker: name } as unknown as ExtensionContext);
    const full: CaptchaAdapter = { widget: () => ({ provider: "fake", script: "https://captcha.example/api.js", global: "fake", siteKey: "public" }), verify: async (answer) => answer === "good", authForms: () => ["forgot-password"], ...adapter };
    provideCmsConfig(defineCms({ plugins: [{ name, version: "1.0.0", apiVersion: 1, auth: { captcha: full } }] }));
    return full;
  }

  it("asks for an answer only on the forms the adapter names", async () => {
    install({});
    expect(await checkAuthRequest("/sign-in/email", null, null)).toBeNull();
    expect(await checkAuthRequest("/request-password-reset", null, null)).toMatchObject({ status: 400, code: "CAPTCHA_REQUIRED" });
    expect(await checkAuthRequest("/request-password-reset", "bad", null)).toMatchObject({ status: 403, code: "CAPTCHA_FAILED" });
    expect(await checkAuthRequest("/request-password-reset", "good", null)).toBeNull();
  });

  it("asks for nothing while no adapter is ready", async () => {
    install({ ready: async () => false });
    expect(await checkAuthRequest("/request-password-reset", null, null)).toBeNull();
    expect(await authCaptcha()).toBeNull();
    expect(await extensionCaptcha.widget()).toBeNull();
    expect(await extensionCaptcha.verify("good", { ip: null })).toBe(false);
  });

  it("refuses when the provider can't be asked, and on every form when the adapter can't say which", async () => {
    install({ verify: async () => { throw new Error("down"); }, authForms: () => { throw new Error("broken"); } });
    expect(await checkAuthRequest("/sign-up/email", "good", null)).toMatchObject({ status: 403 });
    expect(await checkAuthRequest("/sign-in/email", null, null)).toMatchObject({ status: 400 });
  });

  it("passes plugins the answer and the caller's address, with the adapter's own context", async () => {
    const verify = vi.fn(async () => true);
    install({ verify });
    expect(await extensionCaptcha.verify("answer", { ip: "198.51.100.4" })).toBe(true);
    expect(verify).toHaveBeenCalledWith("answer", { ip: "198.51.100.4" }, { marker: "guard" });
    expect(await extensionCaptcha.verify("x".repeat(5000), { ip: null })).toBe(false);
  });

  it.each([
    ["a script over http", { script: "http://captcha.example/api.js" }],
    ["a javascript: script", { script: "javascript:alert(1)" }],
    ["a global that isn't a name", { global: "a.b" }],
    ["markup in the site key", { siteKey: '"><script>' }],
  ])("shows no widget for %s", async (_, change) => {
    install({ widget: () => ({ provider: "fake", script: "https://captcha.example/api.js", global: "fake", siteKey: "public", ...change }) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await authCaptcha()).toBeNull();
    expect(await extensionCaptcha.widget()).toBeNull();
  });

  it("gives sign-in screens the widget and the forms it guards, keeping only plain options", async () => {
    install({ widget: () => ({ provider: "fake", script: "https://captcha.example/api.js?render=explicit", global: "fake", siteKey: "public", options: { theme: "dark", "bad name": "x", nested: { a: 1 } as never } }) });
    expect(await authCaptcha()).toEqual({ forms: ["forgot-password"], widget: { provider: "fake", script: "https://captcha.example/api.js?render=explicit", global: "fake", siteKey: "public", options: { theme: "dark" } } });
  });
});
