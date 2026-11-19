import { describe, expect, it } from "vitest";
import { plainOrigin } from "@/core/http/plugin-origins";
import { normalizeHost, originFor, proof } from "../../plugins/multi-tenant/domains";

describe("tenants' domains", () => {
  const reserved = new Set(["cms.example.com"]);

  it("takes a domain as people type it, and stores only the host", () => {
    expect(normalizeHost("Shop.Example.com", reserved)).toBe("shop.example.com");
    expect(normalizeHost("https://www.example.com/", reserved)).toBe("www.example.com");
    expect(normalizeHost("example.com.", reserved)).toBe("example.com");
  });

  it("refuses what can't be a tenant's site", () => {
    for (const value of ["localhost", "example", "127.0.0.1", "[::1]", "a.localhost", "cms.example.com", "example.com/path", "exa mple.com", "-bad.example.com", "x".repeat(250) + ".com", "javascript:alert(1)"]) {
      expect(normalizeHost(value, reserved), value).toBeNull();
    }
  });

  it("serves a tenant's site with the dashboard's scheme and port", () => {
    expect(originFor("shop.example.com", "https://cms.example.com")).toBe("https://shop.example.com");
    expect(originFor("shop.example.test", "http://localhost:3457")).toBe("http://shop.example.test:3457");
    expect(proof("abc")).toBe("cms-verification=abc");
  });
});

describe("origins plugins trust", () => {
  it("takes only plain http(s) origins", () => {
    expect(plainOrigin("https://shop.example.com")).toBe("https://shop.example.com");
    expect(plainOrigin("http://shop.example.test:3457")).toBe("http://shop.example.test:3457");
    for (const value of ["https://*.example.com", "https://shop.example.com/path", "ftp://shop.example.com", "shop.example.com", "", null, 42, "https://shop.example.com?x=1"]) {
      expect(plainOrigin(value), String(value)).toBeNull();
    }
  });
});
