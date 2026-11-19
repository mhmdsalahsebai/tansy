import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineField } from "@/core/fields/define";
import { buildRegistry, editorInput, fieldCatalogue, fieldStorage, resolveFieldConfig, fieldTypeNames } from "@/core/fields/registry";
import { patternProblem } from "@/core/fields/safe-pattern";
import { validateValues, withDefaults } from "@/core/fields/validate";
import { HttpError } from "@/core/http/errors";

const config = (type: string, raw: Record<string, unknown> = {}) => {
  const resolved = resolveFieldConfig(type, raw);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
  return resolved.config;
};
const field = (type: string, raw: Record<string, unknown> = {}) => ({ name: "f", type, config: config(type, raw) });

function problems(fn: () => unknown): Array<{ path: string; message: string }> {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.details as Array<{ path: string; message: string }>;
    throw error;
  }
  return [];
}
const accepts = (type: string, raw: Record<string, unknown>, value: unknown) =>
  problems(() => validateValues([field(type, raw)], { f: value })).length === 0;

const OPTIONS = { options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "Off", value: "off", disabled: true }] };

describe("a field whose plugin was removed", () => {
  const orphan = { name: "f", type: "gone_type", config: { required: true, defaultValue: "x" } };

  it("is read with the column kind saved with it", () => {
    expect(fieldStorage({ type: "gone_type", storage: "json" }).sql).toBe("json");
    expect(fieldStorage({ type: "gone_type" }).sql).toBe("text");
    expect(fieldStorage({ type: "text", storage: "json", config: {} }).sql).toBe("text");
    expect(editorInput("gone_type")).toBe("unavailable");
  });

  it("never stops a save, and never takes a new value", () => {
    expect(validateValues([orphan, field("text")].map((f, i) => (i ? { ...f, name: "other" } : f)), { f: "changed", other: "kept" }, { f: "stored" })).toEqual({ other: "kept" });
    expect(validateValues([orphan], {})).toEqual({});
    expect(withDefaults([orphan], {})).toEqual({});
  });
});

describe("field registry", () => {
  const custom = (type: string) => defineField({ type, admin: { label: "X", input: "text" }, config: { limit: z.number().optional() }, value: () => z.string(), storage: () => ({ sql: "text" }) });

  it("defines the built-in types", () => {
    expect(fieldTypeNames().sort()).toEqual(["boolean", "checkbox", "code", "date", "datetime", "email", "file", "gallery", "image", "json", "number", "radio", "reference", "rich_text", "stream", "text", "url"]);
  });
  it("accepts custom types and refuses clashes or unsafe names", () => {
    expect([...buildRegistry([custom("slug")]).keys()]).toContain("slug");
    expect(() => buildRegistry([custom("text")])).toThrow(/twice/);
    expect(() => buildRegistry([custom("slug"), custom("slug")])).toThrow(/twice/);
    expect(() => buildRegistry([custom("Bad Name")])).toThrow(/Invalid/);
  });
  it("describes every type's config so the dashboard can generate its form", () => {
    for (const entry of fieldCatalogue()) {
      expect(entry.label, entry.type).toBeTruthy();
      expect(entry.configSchema.type, entry.type).toBe("object");
      expect(Object.keys(entry.configSchema.properties ?? {}), entry.type).toContain("required");
    }
    const byType = Object.fromEntries(fieldCatalogue().map((e) => [e.type, e.configSchema.properties as Record<string, Record<string, unknown>>]));
    expect(byType.text.maxLength.type).toBe("integer");
    expect(byType.radio.options.widget).toBe("options");
    expect(byType.reference.collection.widget).toBe("collection");
  });
  it("rejects unknown types and bad config", () => {
    expect(resolveFieldConfig("nope", {}).ok).toBe(false);
    expect(resolveFieldConfig("radio", {}).ok).toBe(false);
    expect(resolveFieldConfig("number", { min: "abc" }).ok).toBe(false);
  });
  it("treats blank form inputs as unset and coerces numeric strings", () => {
    expect(config("text", { maxLength: "10", pattern: "" })).toMatchObject({ maxLength: 10 });
  });
  it("refuses uniqueness on JSON storage", () => {
    expect(resolveFieldConfig("json", { unique: true }).ok).toBe(false);
  });
  it("validates default values against the field", () => {
    expect(resolveFieldConfig("number", { max: 5, defaultValue: 9 }).ok).toBe(false);
    expect(resolveFieldConfig("number", { max: 5, defaultValue: 3 }).ok).toBe(true);
  });
  it("refuses unsafe link protocols in config", () => {
    expect(resolveFieldConfig("url", { allowedProtocols: ["javascript"] }).ok).toBe(false);
  });
  it("stores multi-value references as JSON that keeps its target", () => {
    expect(resolveFieldConfig("reference", { collection: 1, allowMultiple: true })).toMatchObject({ ok: true, storage: { sql: "json", references: 1 } });
    expect(resolveFieldConfig("reference", { collection: 1, allowMultiple: true, unique: true }).ok).toBe(false);
  });
});

describe("field values", () => {
  it.each([
    ["text", {}, "ok", 5],
    ["text", { maxLength: 2 }, "ab", "abc"],
    ["text", { pattern: "^[a-z]+$" }, "abc", "ABC"],
    ["rich_text", {}, { type: "doc" }, "<b>html</b>"],
    ["code", { maxLines: 1 }, "a", "a\nb"],
    ["number", { min: 1, max: 3 }, 2, 4],
    ["number", {}, 2, "2"],
    ["number", { format: "integer" }, 2, 2.5],
    ["email", {}, "a@b.co", "nope"],
    ["email", { allowedDomains: ["b.co"] }, "a@b.co", "a@c.co"],
    ["email", { blockDomains: ["b.co"] }, "a@c.co", "a@b.co"],
    ["url", {}, "https://a.co", "javascript:alert(1)"],
    ["url", { allowedDomains: ["a.co"] }, "https://x.a.co/p", "https://evil.co"],
    ["date", {}, "2026-02-03", "2026-02-31"],
    ["date", { min: "2026-01-01" }, "2026-01-01", "2025-12-31"],
    ["date", { disabledDays: [0] }, "2026-11-09", "2026-11-08"],
    ["datetime", {}, "2026-11-09T10:00:00+02:00", "2026-11-09"],
    ["datetime", { min: "2026-01-01T00:00:00Z" }, "2026-01-01T00:00:00Z", "2025-12-31T23:59:59Z"],
    ["image", {}, "file_1", 7],
    ["file", {}, "file_1", ["file_1"]],
    ["gallery", { maxItems: 1 }, ["a"], ["a", "b"]],
    ["checkbox", OPTIONS, ["a", "b"], ["a", "a"]],
    ["checkbox", OPTIONS, ["a"], ["off"]],
    ["checkbox", { ...OPTIONS, maxSelect: 1 }, ["a"], ["a", "b"]],
    ["radio", OPTIONS, "a", "z"],
    ["radio", OPTIONS, "b", "off"],
    ["reference", { collection: 1 }, 5, -1],
    ["reference", { collection: 1 }, 5, 2147483648],
    ["reference", { collection: 1 }, 5, [5]],
    ["reference", { collection: 1, allowMultiple: true }, [5, 6], 5],
    ["reference", { collection: 1, allowMultiple: true }, [5, 6], [5, 5]],
    ["reference", { collection: 1, allowMultiple: true }, [5], [-1]],
    ["reference", { collection: 1, allowMultiple: true, maxSelect: 1 }, [5], [5, 6]],
    ["boolean", {}, false, "false"],
  ])("%s %j", (type, raw, good, bad) => {
    expect(accepts(type, raw, good)).toBe(true);
    expect(accepts(type, raw, bad)).toBe(false);
  });

  it("rejects text Postgres cannot store", () => {
    expect(accepts("text", {}, "a\u0000b")).toBe(false);
    expect(accepts("text", {}, "\ud83d")).toBe(false);
    expect(accepts("json", {}, { a: ["x\u0000"] })).toBe(false);
    expect(accepts("json", {}, { "k\u0000": 1 })).toBe(false);
  });
  it("rejects JSON nested too deeply to process safely", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(accepts("json", {}, deep)).toBe(false);
    expect(accepts("json", {}, { a: [1, { b: null }] })).toBe(true);
  });
  it("reports errors by field name, including nested paths", () => {
    const fields = [{ name: "title", type: "text", config: { required: true } }, field("gallery")];
    fields[1].name = "photos";
    expect(problems(() => validateValues(fields, { photos: ["ok", 7] }))).toEqual([
      { path: "title", message: "This field is required." },
      { path: "photos.1", message: expect.any(String) },
    ]);
  });
  it("treats an empty string as no value for every type", () => {
    expect(validateValues([field("number")], { f: "" })).toEqual({ f: null });
    expect(problems(() => validateValues([field("number", { required: true })], { f: "" }))[0].path).toBe("f");
  });
  it("accepts false and zero for required fields", () => {
    expect(validateValues([field("boolean", { required: true })], { f: false })).toEqual({ f: false });
    expect(validateValues([field("number", { required: true })], { f: 0 })).toEqual({ f: 0 });
  });
  it("leaves omitted fields alone on update, even when required", () => {
    expect(validateValues([field("text", { required: true })], {}, { f: "kept" })).toEqual({});
  });
  it("drops keys that are not fields, so system columns cannot be set", () => {
    expect(validateValues([field("text")], { f: "x", id: 9, status: "published", createdById: "u" })).toEqual({ f: "x" });
  });
  it("blocks changes to read-only fields on update only", () => {
    const f = field("text", { readonly: true });
    expect(validateValues([f], { f: "x" })).toEqual({ f: "x" });
    expect(problems(() => validateValues([f], { f: "y" }, { f: "x" }))[0].message).toMatch(/read-only/);
    expect(validateValues([f], { f: "x" }, { f: "x" })).toEqual({ f: "x" });
  });
  it("compares read-only datetimes by instant", () => {
    const f = field("datetime", { readonly: true });
    expect(problems(() => validateValues([f], { f: "2026-01-01T02:00:00+02:00" }, { f: new Date("2026-01-01T00:00:00Z") }))).toEqual([]);
  });
  it("applies defaults to missing and blank values", () => {
    const f = field("number", { defaultValue: 3 });
    expect(withDefaults([f], {})).toEqual({ f: 3 });
    expect(withDefaults([f], { f: "" })).toEqual({ f: 3 });
    expect(withDefaults([f], { f: 1 })).toEqual({ f: 1 });
  });
});

describe("field patterns", () => {
  it.each(["^[a-z]+$", "^(foo|bar)$", "^\\d{3}-\\d{4}$", "(?:ab)?c+", "^[(+*]+$", "\\(a+\\)+"])("allows %s", (source) => {
    expect(patternProblem(source)).toBeNull();
  });
  it.each(["(a+)+$", "(a*)*", "(a|aa)+$", "((a+))+", "(a+){2,}", "(a+?)+", "(a)\\1", "(?<n>a)\\k<n>", "a+b+c+", "(", "x".repeat(501)])("rejects %s", (source) => {
    expect(patternProblem(source)).not.toBeNull();
  });
  it("is enforced when a field is saved", () => {
    expect(resolveFieldConfig("text", { pattern: "(a+)+$" }).ok).toBe(false);
  });
});
