import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, defineCsp } from "@/core/extend/csp";

const env = { dev: false, https: true };

describe("plugin additions to the Content Security Policy", () => {
  it("adds exact origins to the allowed directives only", () => {
    const csp = contentSecurityPolicy("n", false, defineCsp({ frame: ["https://a.example"], connect: ["https://b.example"], img: ["https://c.example:8443"] }), env);
    expect(csp).toContain("frame-src https://a.example");
    expect(csp).toContain("connect-src 'self' https://b.example");
    expect(csp).toContain("img-src 'self' data: blob: https://c.example:8443");
    expect(csp).toContain("script-src 'self' 'nonce-n' 'strict-dynamic';");
  });
  it("leaves the default policy alone when nothing is added", () => expect(contentSecurityPolicy("n", false, {}, env)).not.toContain("frame-src"));
  it("never adds anything to API responses", () => expect(contentSecurityPolicy("n", true, { frame: ["https://a.example"] }, env)).toBe("default-src 'none'; frame-ancestors 'none'"));
  it.each(["*", "https:", "'unsafe-inline'", "https://*.example", "https://a.example; script-src *", "https://a.example/path", "data:"])("refuses %s", (source) => {
    expect(() => defineCsp({ frame: [source] })).toThrow(/Invalid Content Security Policy/);
  });
});
