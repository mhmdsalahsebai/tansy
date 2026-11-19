import { describe, expect, it } from "vitest";
import { sanitizeMetadata } from "@/core/audit";
import { lockDelaySeconds } from "@/core/auth/lockout";
import { decryptSecret, encryptSecret } from "@/core/auth/secrets";
import { maskSettings, SECRET_MASK, validateSettingsInvariants } from "@/core/auth/settings";
import { authSettingsSchema } from "@/core/auth/settings-schema";
import { fromStatements, grants, holdsRecordPermission, holdsRecordPermissionAnywhere, holdsRecordPermissionForSome, isKnownPermission, scopedCollectionId, toStatements } from "@/core/authz/permissions";
import { decideRecord, isLocked } from "@/core/authz/records";
import { ANONYMOUS, type Principal } from "@/core/authz/principal";
import { isSubset, parseRoleNames, permissionsForRole } from "@/core/authz/roles";
import { isCrossSiteRequest } from "@/core/http/request";

const defaults = () => authSettingsSchema.parse({});

describe("defaults", () => {
  it("are the secure choice", () => {
    const s = defaults();
    expect(s.signUp.enabled).toBe(false);
    expect(s.password.minLength).toBe(15);
    expect(s.lockout.enabled).toBe(true);
    expect(s.rateLimit.enabled).toBe(true);
    expect(s.oauth.allowAccountLinking).toBe(false);
    expect(s.mail.requireStartTls).toBe(true);
  });
});

describe("settings invariants", () => {
  const roles = new Map([["user", new Set<string>()], ["admin", new Set(["dashboard:access"])]]);
  const problems = (mutate: (s: ReturnType<typeof defaults>) => void, production = false) => {
    const s = defaults();
    mutate(s);
    return validateSettingsInvariants(s, roles, { production }).map((p) => p.path);
  };
  it("accepts defaults", () => expect(problems(() => {})).toEqual([]));
  it("rejects a privileged sign-up role", () => expect(problems((s) => { s.signUp.defaultRole = "admin"; })).toContain("signUp.defaultRole"));
  it("rejects removing every admin sign-in path", () => expect(problems((s) => { s.methods.password = false; s.methods.passkey = false; })).toContain("methods.password"));
  it("rejects requiring MFA with TOTP off", () => expect(problems((s) => { s.mfa.requireForDashboard = true; s.mfa.totp = false; })).toContain("mfa.totp"));
  it("rejects mail features without SMTP in production", () => expect(problems((s) => { s.methods.magicLink = true; }, true)).toContain("mail.host"));
  it("accepts mail features without SMTP when a mail plugin is ready", () => {
    const s = defaults();
    s.methods.magicLink = true;
    expect(validateSettingsInvariants(s, roles, { production: true, pluginMail: true }).map((p) => p.path)).not.toContain("mail.host");
  });
  it("rejects an enabled provider without credentials", () => expect(problems((s) => { s.oauth.providers.github = { enabled: true, clientId: "", clientSecret: "" }; })).toContain("oauth.providers.github"));
  it("masks secrets", () => {
    const s = defaults();
    s.mail.password = "hunter2";
    s.oauth.providers.google = { enabled: false, clientId: "", clientSecret: "abc" };
    s.oauth.providers.github = { enabled: false, clientId: "", clientSecret: "" };
    const masked = maskSettings(s);
    expect(masked.mail.password).toBe(SECRET_MASK);
    expect(masked.oauth.providers.google.clientSecret).toBe(SECRET_MASK);
    expect(masked.oauth.providers.github.clientSecret).toBe("");
  });
});

describe("secret encryption", () => {
  it("round-trips, is randomized, and rejects tampering", () => {
    const a = encryptSecret("s3cret");
    expect(a).not.toContain("s3cret");
    expect(encryptSecret("s3cret")).not.toBe(a);
    expect(decryptSecret(a)).toBe("s3cret");
    const raw = Buffer.from(a.slice("enc:v1:".length), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret("enc:v1:" + raw.toString("base64url"))).toThrow();
  });
});

describe("lockout delay", () => {
  const cfg = { enabled: true, maxFailures: 5, baseDelaySeconds: 30, maxDelaySeconds: 3600 };
  it("doubles after the threshold and caps", () => {
    expect(lockDelaySeconds(4, cfg)).toBe(0);
    expect(lockDelaySeconds(5, cfg)).toBe(30);
    expect(lockDelaySeconds(6, cfg)).toBe(60);
    expect(lockDelaySeconds(500, cfg)).toBe(3600);
  });
});

describe("permissions", () => {
  it("converts to and from better-auth statements", () => {
    const statements = toStatements(["user:list", "user:ban", "ext.seo:read"]);
    expect(statements).toEqual({ user: ["list", "ban"], "ext.seo": ["read"] });
    expect([...fromStatements(statements)]).toEqual(["user:list", "user:ban", "ext.seo:read"]);
    expect(fromStatements(null).size).toBe(0);
  });
  it("knows its catalogue", () => {
    expect(isKnownPermission("user:list")).toBe(true);
    expect(isKnownPermission("user:fly")).toBe(false);
  });
  it("grants nothing for unknown roles and unions multiple roles", () => {
    const map = new Map([["a", new Set(["x"])], ["b", new Set(["y"])]]);
    expect(permissionsForRole(map, "ghost").size).toBe(0);
    expect(permissionsForRole(map, null).size).toBe(0);
    expect([...permissionsForRole(map, "a, b")].sort()).toEqual(["x", "y"]);
    expect(parseRoleNames(" a,,b ")).toEqual(["a", "b"]);
    expect(isSubset(["x"], new Set(["x", "y"]))).toBe(true);
    expect(isSubset(["z"], new Set(["x"]))).toBe(false);
  });
});

describe("record decisions", () => {
  const rules = (rule: string | null, id = 1) => ({ id, slug: "posts", listRule: rule, viewRule: rule, createRule: rule, updateRule: rule, deleteRule: rule });
  const request = { method: "GET", headers: new Headers(), query: {}, body: {} };
  const staff: Principal = { ...ANONYMOUS, permissions: new Set(["record:read"]) };
  it("locks by default, including for signed-out callers", () => expect(decideRecord(ANONYMOUS, rules(null), "view", {}, request)).toBe("locked"));
  it("treats an empty rule as public", () => expect(decideRecord(ANONYMOUS, rules(""), "view", {}, request)).toBe("allow"));
  it("evaluates expressions", () => {
    expect(decideRecord(ANONYMOUS, rules('status = "published"'), "view", { status: "published" }, request)).toBe("allow");
    expect(decideRecord(ANONYMOUS, rules('status = "published"'), "view", { status: "draft" }, request)).toBe("denied");
    expect(decideRecord(ANONYMOUS, rules('@request.auth.id != ""'), "view", {}, request)).toBe("denied");
  });
  it("lets role permissions bypass rules, per action only", () => {
    expect(decideRecord(staff, rules(null), "view", {}, request)).toBe("allow");
    expect(decideRecord(staff, rules(null), "delete", {}, request)).toBe("locked");
  });
  it("lets a per-collection grant bypass rules in that collection only", () => {
    const scoped: Principal = { ...ANONYMOUS, permissions: new Set(["record:update@c7"]) };
    expect(decideRecord(scoped, rules(null, 7), "update", {}, request)).toBe("allow");
    expect(decideRecord(scoped, rules(null, 8), "update", {}, request)).toBe("locked");
    expect(decideRecord(scoped, rules(null, 7), "view", {}, request)).toBe("locked");
    expect(decideRecord(scoped, rules('status = "published"', 70), "update", { status: "draft" }, request)).toBe("denied");
  });
});

declare const globalThis: { cmsConfig?: { plugins?: unknown[] } } & typeof global;

describe("system-owned collections", () => {
  const rule = "";
  const owned = { id: 9, slug: "acme-ledger", listRule: rule, viewRule: rule, createRule: rule, updateRule: rule, deleteRule: rule };
  const request = { method: "POST", headers: new Headers(), query: {}, body: {} };
  const withPlugin = <T>(work: () => T): T => {
    const original = globalThis.cmsConfig;
    globalThis.cmsConfig = { ...original, plugins: [...(original?.plugins ?? []), { name: "acme", version: "1.0.0", apiVersion: 1, systemCollections: ["acme-ledger"] }] };
    try { return work(); } finally { globalThis.cmsConfig = original; }
  };
  const acme: Principal = { kind: "anonymous", permissions: new Set(["record:create", "record:update", "record:delete"]), system: "plugin:acme" };
  const other: Principal = { kind: "anonymous", permissions: acme.permissions, system: "plugin:other" };
  const staff: Principal = { ...ANONYMOUS, permissions: new Set(["record:list", "record:read", "record:create", "record:update", "record:delete"]) };
  const author: Principal = { ...ANONYMOUS, permissions: new Set(["record:read@c9:own"]) };

  it("is written only by its own plugin's system records, whatever roles or rules say", () => withPlugin(() => {
    for (const action of ["create", "update", "delete"] as const) {
      expect(decideRecord(acme, owned, action, {}, request)).toBe("allow");
      expect(decideRecord(other, owned, action, {}, request)).toBe("locked");
      expect(decideRecord(staff, owned, action, {}, request)).toBe("locked");
      expect(decideRecord(ANONYMOUS, owned, action, {}, request)).toBe("locked");
      expect(isLocked(staff, owned, action)).toBe(true);
      expect(isLocked(acme, owned, action)).toBe(false);
    }
  }));

  it("is read with role permissions only: no rule or own grant opens it", () => withPlugin(() => {
    expect(decideRecord(staff, owned, "view", {}, request)).toBe("allow");
    expect(decideRecord(ANONYMOUS, owned, "view", {}, request)).toBe("locked");
    expect(isLocked(ANONYMOUS, owned, "list")).toBe(true);
    expect(decideRecord(author, owned, "view", { createdById: "" }, request)).toBe("locked");
  }));

  it("must be named after its plugin", () => {
    const original = globalThis.cmsConfig;
    globalThis.cmsConfig = { ...original, plugins: [{ name: "acme", version: "1.0.0", apiVersion: 1, systemCollections: ["posts"] }] };
    try {
      expect(() => decideRecord(staff, { ...owned, slug: "posts" }, "view", {}, request)).toThrow(/must start with "acme-"/);
    } finally { globalThis.cmsConfig = original; }
  });
});

describe("per-collection permissions", () => {
  it("are known only in their exact form", () => {
    expect(isKnownPermission("record:read@c12")).toBe(true);
    for (const bad of ["record:read@c0", "record:read@c01", "record:read@12", "record:fly@c1", "collection:read@c1", "record:read@c1x", "user:list@c1"]) {
      expect(isKnownPermission(bad), bad).toBe(false);
    }
  });
  it("hold for their collection, and the plain form holds for all", () => {
    expect(holdsRecordPermission(new Set(["record:read@c3"]), "record:read", 3)).toBe(true);
    expect(holdsRecordPermission(new Set(["record:read@c3"]), "record:read", 33)).toBe(false);
    expect(holdsRecordPermission(new Set(["record:read@c3"]), "record:list", 3)).toBe(false);
    expect(holdsRecordPermission(new Set(["record:read"]), "record:read", 99)).toBe(true);
    expect(scopedCollectionId("record:delete@c42")).toBe(42);
    expect(scopedCollectionId("record:delete")).toBeNull();
  });
});

describe("CSRF origin checks", () => {
  const settings = defaults();
  settings.network.trustedOrigins = ["https://*.example.com"];
  const cross = (headers: Record<string, string>) => isCrossSiteRequest(new Headers(headers), settings);
  it("allows same-origin requests", () => {
    expect(cross({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(cross({ origin: "https://app.example.com" })).toBe(false);
  });
  it("rejects cross-site and unprovable requests", () => {
    expect(cross({ "sec-fetch-site": "cross-site", origin: "http://localhost:3000" })).toBe(true);
    expect(cross({ origin: "https://evil.test" })).toBe(true);
    expect(cross({ origin: "https://app.example.com.evil.test" })).toBe(true);
    expect(cross({ origin: "null" })).toBe(true);
    expect(cross({})).toBe(true);
  });
});

describe("audit metadata", () => {
  it("drops anything that looks like a credential", () => {
    expect(sanitizeMetadata({ password: "x", apiKey: "y", backupCode: "z", email: "a@b.c", accessToken: "t" })).toEqual({ email: "a@b.c" });
  });
});

describe("own-record permissions", () => {
  const rules = (rule: string | null, id = 7) => ({ id, slug: "posts", listRule: rule, viewRule: rule, createRule: rule, updateRule: rule, deleteRule: rule });
  const request = { method: "GET", headers: new Headers(), query: {}, body: {} };
  const user = (id: string, permissions: string[]) => ({ kind: "user", user: { id }, permissions: new Set(permissions) }) as unknown as Principal;
  const author = user("u1", ["record:update@c7:own", "record:read@c7:own", "record:create@c7"]);

  it("are known only in their exact form, never for create", () => {
    expect(isKnownPermission("record:update@c7:own")).toBe(true);
    for (const bad of ["record:create@c7:own", "record:update:own", "record:update@c7:mine", "record:update@c0:own", "user:list@c1:own"]) expect(isKnownPermission(bad), bad).toBe(false);
    expect(scopedCollectionId("record:delete@c42:own")).toBe(42);
  });

  it("are covered by the collection's grant and the global one, and cover neither", () => {
    expect(grants(new Set(["record:update"]), "record:update@c7:own")).toBe(true);
    expect(grants(new Set(["record:update@c7"]), "record:update@c7:own")).toBe(true);
    expect(grants(new Set(["record:update@c8"]), "record:update@c7:own")).toBe(false);
    expect(grants(new Set(["record:update@c7:own"]), "record:update@c7")).toBe(false);
    expect(isSubset(["record:update@c7"], new Set(["record:update@c7:own"]))).toBe(false);
    expect(holdsRecordPermission(author.permissions, "record:update", 7)).toBe(false);
    expect(holdsRecordPermissionForSome(author.permissions, "record:update", 7)).toBe(true);
    expect(holdsRecordPermissionForSome(author.permissions, "record:update", 8)).toBe(false);
    expect(holdsRecordPermissionAnywhere(author.permissions, "record:read")).toBe(true);
    expect(holdsRecordPermissionAnywhere(author.permissions, "record:list")).toBe(false);
  });

  it("allow only the holder's own records, and hide others' as missing", () => {
    expect(decideRecord(author, rules(null), "update", { createdById: "u1" }, request)).toBe("allow");
    expect(decideRecord(author, rules(null), "update", { createdById: "u2" }, request)).toBe("denied");
    expect(decideRecord(author, rules(null), "update", { createdById: "" }, request)).toBe("denied");
    expect(decideRecord(author, rules(null, 8), "update", { createdById: "u1" }, request)).toBe("locked");
    expect(decideRecord(author, rules(null), "delete", { createdById: "u1" }, request)).toBe("locked");
    expect(isLocked(author, rules(null), "update")).toBe(false);
    expect(isLocked(author, rules(null), "delete")).toBe(true);
  });

  it("add to what the rule allows, never replace it", () => {
    expect(decideRecord(author, rules('status = "published"'), "view", { createdById: "u2", status: "published" }, request)).toBe("allow");
    expect(decideRecord(author, rules('status = "published"'), "view", { createdById: "u2", status: "draft" }, request)).toBe("denied");
  });

  it("never match for a caller without an id, or an empty creator", () => {
    const blank = user("", ["record:update@c7:own"]);
    expect(decideRecord(blank, rules(null), "update", { createdById: "" }, request)).toBe("denied");
    const anonymous: Principal = { ...ANONYMOUS, permissions: new Set(["record:update@c7:own"]) };
    expect(decideRecord(anonymous, rules(null), "update", { createdById: "" }, request)).toBe("locked");
  });
});
