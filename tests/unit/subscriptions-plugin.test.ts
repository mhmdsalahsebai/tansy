import { describe, expect, it } from "vitest";
import { evaluateRule, validateRule, type RuleContext } from "@/core/authz/rules/evaluate";
import { assertPluginManifest } from "@/core/extend/manifest";
import { subscriptions } from "../../plugins/subscriptions";
import { countByPlan, gated, gateOf, grantEnd, ungated } from "../../plugins/subscriptions/logic";

const as = (access: unknown, record: Record<string, unknown>): RuleContext => ({
  record: { status: "published", ...record },
  request: { auth: access === undefined ? { id: "" } : { id: "u1", payments_access: access }, body: {}, query: {}, headers: {}, method: "GET", context: "default" },
  now: new Date("2026-11-14T00:00:00Z"),
});

describe("gating a collection", () => {
  const before = 'status = "published"';

  it("only ever adds a condition, and keeps locked rules locked", () => {
    expect(gated(null, "records", "posts")).toBeNull();
    expect(gated("", "collection", "posts")).toBe('(@request.auth.payments_access ?= "posts")');
    const rule = gated(before, "records", "posts")!;
    expect(rule.startsWith(`(${before}`)).toBe(true);
    // Gating twice changes nothing.
    expect(gated(rule, "records", "posts")).toBe(rule);
    expect(() => gated(before, "collection", 'x" || true')).toThrow();
  });

  it("opens records in no access as before, and the rest to plans that include them", () => {
    const rule = gated(before, "records", "posts")!;
    expect(validateRule(rule, ["included"], undefined, ["payments_access"])).toBeNull();
    for (const access of [undefined, [], [9]]) {
      expect(evaluateRule(rule, as(access, { included: [] }))).toBe(true);
      expect(evaluateRule(rule, as(access, { included: [3] }))).toBe(false);
    }
    expect(evaluateRule(rule, as([3], { included: [3] }))).toBe(true);
    // What the rule required before still applies.
    expect(evaluateRule(rule, as([3], { included: [3], status: "draft" }))).toBe(false);
  });

  it("opens a whole collection only to plans whose access lists it", () => {
    const rule = gated(before, "collection", "posts")!;
    expect(evaluateRule(rule, as(["posts"], {}))).toBe(true);
    for (const access of [undefined, [], ["other"], [3]]) expect(evaluateRule(rule, as(access, {}))).toBe(false);
  });

  it("can't be undone by a trailing comment in the old rule", () => {
    const rule = gated(`${before} // members first`, "collection", "posts")!;
    expect(evaluateRule(rule, as(undefined, {}))).toBe(false);
    expect(evaluateRule(rule, as(["posts"], {}))).toBe(true);
  });

  it("removes exactly what it added", () => {
    for (const old of [before, "", `${before} // note`, '(a = 1) || (b = 2)']) {
      for (const mode of ["records", "collection"] as const) {
        const rule = gated(old, mode, "posts");
        expect(gateOf(rule, "posts")).toBe(mode);
        expect(ungated(rule, "posts")).toBe(old);
      }
    }
    // A rule someone wrote themselves is left alone.
    expect(gateOf('@request.auth.payments_access ?= "posts"', "posts")).toBeNull();
    expect(ungated(before, "posts")).toBe(before);
    expect(gateOf(gated(before, "collection", "posts"), "other")).toBeNull();
  });
});

describe("subscriptions plugin", () => {
  it("is a valid plugin", () => {
    expect(() => assertPluginManifest(subscriptions())).not.toThrow();
  });

  it("takes only future end dates for free plans", () => {
    const now = Date.parse("2026-11-14T00:00:00Z");
    expect(grantEnd(null, now)).toBeNull();
    expect(grantEnd("", now)).toBeNull();
    expect(grantEnd("2026-12-01T00:00:00Z", now)).toBe("2026-12-01T00:00:00.000Z");
    expect(grantEnd("2026-11-01T00:00:00Z", now)).toBe("invalid");
    expect(grantEnd("soon", now)).toBe("invalid");
  });

  it("counts people per plan", () => {
    expect([...countByPlan([{ plans: ["pro", "team"] }, { plans: ["pro"] }, { plans: [] }, {}])]).toEqual([["pro", 2], ["team", 1]]);
  });
});
