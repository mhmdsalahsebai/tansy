import { describe, expect, it } from "vitest";
import { evaluateRule, type RuleContext } from "@/core/authz/rules/evaluate";
import { assertPluginManifest } from "@/core/extend/manifest";
import { ARTICLE_RULE, LIBRARY, LIBRARY_RULE, planAccessExample } from "../../examples/plan-access";

/** As core builds it: a visitor has an empty id and no custom fields. */
const as = (access: unknown, record: Record<string, unknown>): RuleContext => ({
  record: { status: "published", ...record },
  request: { auth: access === undefined ? { id: "" } : { id: "u1", payments_access: access }, body: {}, query: {}, headers: {}, method: "GET", context: "default" },
  now: new Date("2026-11-14T00:00:00Z"),
});

const PREMIUM = 7;
const free = { included: [] };
const premium = { included: [PREMIUM] };

describe("plan access rules", () => {
  it("opens free articles to everyone and premium ones only to plans that include them", () => {
    for (const access of [undefined, [], [8, "other-things"]]) {
      expect(evaluateRule(ARTICLE_RULE, as(access, free)), String(access)).toBe(true);
      expect(evaluateRule(ARTICLE_RULE, as(access, premium)), String(access)).toBe(false);
    }
    expect(evaluateRule(ARTICLE_RULE, as([PREMIUM], premium))).toBe(true);
    expect(evaluateRule(ARTICLE_RULE, as([PREMIUM], { ...premium, status: "draft" }))).toBe(false);
  });

  it("opens a whole collection by its slug", () => {
    expect(evaluateRule(LIBRARY_RULE, as([PREMIUM, LIBRARY], {}))).toBe(true);
    for (const access of [undefined, [], [PREMIUM]]) expect(evaluateRule(LIBRARY_RULE, as(access, {}))).toBe(false);
  });

  it("needs the length guard: without it, a record in no access opens to anyone with none", () => {
    const naive = "included ?= @request.auth.payments_access";
    expect(evaluateRule(naive, as(undefined, free))).toBe(true);
    expect(evaluateRule(naive, as([], free))).toBe(true);
    const gate = "included:length > 0 && included ?= @request.auth.payments_access";
    expect(evaluateRule(gate, as(undefined, free))).toBe(false);
    expect(evaluateRule(gate, as([], free))).toBe(false);
    expect(evaluateRule(gate, as([PREMIUM], premium))).toBe(true);
  });

  it("is a valid plugin", () => {
    expect(() => assertPluginManifest(planAccessExample())).not.toThrow();
  });
});
