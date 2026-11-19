import { describe, expect, it } from "vitest";
import { evaluateRule, validateRule, type RuleContext } from "@/core/authz/rules/evaluate";
import { parseRule, RuleSyntaxError } from "@/core/authz/rules/parser";

const ctx = (over: Partial<RuleContext["request"]> = {}, record: Record<string, unknown> = {}): RuleContext => ({
  record: { status: "published", createdById: "u1", views: 5, tags: ["a", "b"], ...record },
  request: { auth: { id: "u1", role: "member", email: "A@x.io" }, body: {}, query: {}, headers: { x_token: "t" }, method: "GET", context: "default", ...over },
  now: new Date("2026-06-15T12:00:00Z"),
});
const run = (rule: string, c = ctx()) => evaluateRule(rule, c);

describe("rule evaluation", () => {
  it("never changes the values it compares, so an empty list stays empty for the next rule", () => {
    const record = { status: "published", included: [] as unknown[] };
    const access: unknown[] = [];
    const c = ctx({ auth: { id: "u1", payments_access: access } }, record);
    expect(run("included ?= @request.auth.payments_access", c)).toBe(true);
    expect(record.included).toEqual([]);
    expect(access).toEqual([]);
    expect(run("included:length > 0", c)).toBe(false);
  });

  it("compares fields and auth", () => {
    expect(run('status = "published"')).toBe(true);
    expect(run('status != "published"')).toBe(false);
    expect(run("@request.auth.id = createdById")).toBe(true);
    expect(run('@request.auth.id = ""', ctx({ auth: { id: "" } }))).toBe(true);
  });
  it("combines with precedence and parentheses", () => {
    expect(run('status = "x" || status = "published" && views > 1')).toBe(true);
    expect(run('(status = "x" || status = "published") && views > 10')).toBe(false);
  });
  it("handles numbers, like and comments", () => {
    expect(run("views >= 5 // comment")).toBe(true);
    expect(run('@request.auth.email ~ "x.io"')).toBe(true);
    expect(run('@request.auth.email ~ "a@%"')).toBe(true);
    expect(run('status !~ "draft"')).toBe(true);
  });
  it("matches arrays with all and any semantics", () => {
    expect(run('tags = "a"')).toBe(false);
    expect(run('tags ?= "a"')).toBe(true);
    expect(run("tags:length = 2")).toBe(true);
  });
  it("supports body modifiers", () => {
    const update = ctx({ body: { status: "draft" } });
    expect(run("@request.body.status:isset = true", update)).toBe(true);
    expect(run("@request.body.status:changed = true", update)).toBe(true);
    expect(run("@request.body.views:changed = true", update)).toBe(false);
    expect(run("@request.body.status:changed = false", ctx({ body: { status: "published" } }))).toBe(true);
    expect(run('@request.auth.email:lower = "a@x.io"')).toBe(true);
  });
  it("reads headers with underscores and has date macros", () => {
    expect(run('@request.headers.x_token = "t"')).toBe(true);
    expect(run('@now > "2026-01-01 00:00:00"')).toBe(true);
    expect(run("@year = 2026")).toBe(true);
    expect(run('createdAt >= @todayStart', ctx({}, { createdAt: new Date("2026-06-15T01:00:00Z") }))).toBe(true);
  });
  it("cannot read prototype properties", () => {
    expect(run('constructor != ""')).toBe(false);
    expect(run('@request.auth.__proto__ != ""')).toBe(false);
  });
  it("fails closed", () => {
    expect(run("this is not a rule")).toBe(false);
    expect(run('status = "published" &&')).toBe(false);
  });
});

describe("rule parsing", () => {
  it("rejects bad syntax and oversized input", () => {
    for (const bad of ["a =", "= b", "(a = 1", 'a = "x', "a ?? b", "a = 1 b = 2", "a:nope = 1"]) {
      expect(() => parseRule(bad), bad).toThrow(RuleSyntaxError);
    }
    expect(() => parseRule("a = 1 && ".repeat(1000) + "a = 1")).toThrow(RuleSyntaxError);
    expect(() => parseRule("(".repeat(100) + "a = 1" + ")".repeat(100))).toThrow(RuleSyntaxError);
  });

  it("reads a hyphen inside a name, because a collection slug can hold one", () => {
    // "<slug>_via_<field>" in a filter, spelled as expand spells it (core/content/relations.ts).
    const node = parseRule('blog-posts_via_author.title ?= "x"');
    expect(node.type === "compare" && node.left).toMatchObject({ kind: "identifier", path: ["blog-posts_via_author", "title"] });
    // A number still wins over a name, so nothing here is arithmetic.
    const negative = parseRule("rank > -5");
    expect(negative.type === "compare" && negative.right).toMatchObject({ kind: "literal", value: -5 });
    for (const bad of ["-a = 1", "a - = 1"]) expect(() => parseRule(bad), bad).toThrow(RuleSyntaxError);
  });
});

describe("rule validation", () => {
  const valid = (rule: string) => validateRule(rule, ["title"]);
  it("accepts known names", () => {
    expect(valid('title != "" && @request.auth.id = createdById && @request.body.title:changed = false')).toBeNull();
  });
  it("rejects typos and unsupported features instead of silently changing access", () => {
    expect(valid('titel = "x"')).toMatch(/Unknown field/);
    expect(valid('@request.auth.passwrd = "x"')).toMatch(/Unknown field/);
    expect(valid('@request.nope = "x"')).toMatch(/Unknown request/);
    expect(valid("@tuesday = 1")).toMatch(/Unknown macro/);
    expect(valid('@collection.users.id = "x"')).toMatch(/not available/);
    expect(valid("title:changed = true")).toMatch(/only applies/);
  });
});
