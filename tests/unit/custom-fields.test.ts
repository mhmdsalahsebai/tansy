import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import config from "@/tansy.config";
import { defineRenderers, mergeRenderers, StreamField, type BlockProps } from "@/components/stream/StreamField";
import { collectionResolver, mapFieldValues, normalizeBlocks, streamFiles, streamIssues, streamLinks, streamRefs, type BlockCatalog } from "@/core/blocks/stream";
import { validateFilter } from "@/core/authz/rules/evaluate";
import { provideCmsConfig } from "@/core/config";
import { diffValues } from "@/core/content/diff";
import { defineField } from "@/core/fields/define";
import { buildRegistry, editorInput, fieldOperators, fieldCatalogue, valueRefs, valueSummary } from "@/core/fields/registry";
import { testFieldDefinition } from "@/core/fields/test-kit";
import { validateValues } from "@/core/fields/validate";
import { searchText } from "@/core/search/extract";
import { isShown } from "@/components/fields/show-if";
import { withFreshIds } from "@/components/stream/stream-ops";

const link = defineField({
  type: "acme_link",
  admin: { label: "Link" },
  config: {},
  value: () => z.strictObject({ label: z.string().min(1), id: z.number(), file: z.string().optional() }),
  normalize: (value) => (value && typeof value === "object" && "label" in value && typeof value.label === "string" ? { ...value, label: value.label.trim() } : value),
  refs: (value) => ({ records: [{ collection: "people", id: value.id }], files: value.file ? [value.file] : [] }),
  search: (value) => [value.label],
  summary: (value) => `${value.label} (#${value.id})`,
  operators: ["="],
  storage: () => ({ sql: "json" }),
});
const broken = defineField({
  type: "acme_broken",
  admin: { label: "Broken", input: "json" },
  config: {},
  value: () => z.object({}).loose(),
  refs: () => { throw new Error("Bad link."); },
  search: () => { throw new Error("no"); },
  summary: () => { throw new Error("no"); },
  storage: () => ({ sql: "json" }),
});
const tooMany = defineField({
  type: "acme_many",
  admin: { label: "Many", input: "json" },
  config: {},
  value: () => z.unknown(),
  refs: () => ({ records: Array.from({ length: 1001 }, (_, index) => ({ collection: 1, id: index + 1 })) }),
  storage: () => ({ sql: "json" }),
});

const field = { name: "link", type: "acme_link", config: {} };
const catalog: BlockCatalog = new Map([
  ["card", { name: "card", version: 1, fields: [field] }],
  ["inner", { name: "inner", version: 1, fields: [{ name: "cards", type: "stream", config: {} }] }],
  ["outer", { name: "outer", version: 1, fields: [{ name: "inners", type: "stream", config: {} }] }],
]);
const value = { label: "Ada", id: 7, file: "file-1" };
const card = { id: "c", type: "card", v: 1, value: { link: value } };
const nested = [{ id: "o", type: "outer", v: 1, value: { inners: [{ id: "i", type: "inner", v: 1, value: { cards: [card] } }] } }];
const resolve = collectionResolver([{ id: 3, slug: "people" }]);

beforeAll(() => provideCmsConfig({ ...config, fields: [link, broken, tooMany] }));
afterAll(() => provideCmsConfig(config));

describe("a third-party object field", () => {
  it("reports links and files from two levels of nested blocks", () => {
    expect(streamLinks(nested, catalog, resolve)).toEqual([{ blockId: "c", field: "link", multiple: true, targetCollectionId: 3, targetRecordIds: [7] }]);
    expect(streamRefs(nested, catalog, resolve).refs).toEqual([{ blockId: "c", targetCollectionId: 3, targetRecordId: 7 }]);
    expect(streamFiles(nested, catalog).files).toEqual([{ blockId: "c", field, fileIds: ["file-1"] }]);
  });

  it("points an unknown slug at no collection, so the existence check refuses it", () => {
    expect(streamRefs(nested, catalog, collectionResolver([])).refs[0].targetCollectionId).toBe(0);
    expect(streamRefs(nested, catalog).refs[0].targetCollectionId).toBe(0);
  });

  it("is normalized at any depth, on a copy, before validation", () => {
    const untidy = [{ ...nested[0], value: { inners: [{ id: "i", type: "inner", v: 1, value: { cards: [{ ...card, value: { link: { ...value, label: "  Ada " } } }] } }] } }];
    const result = normalizeBlocks(untidy, catalog);
    expect(streamLinks(result, catalog, resolve)).toHaveLength(1);
    expect(JSON.stringify(result)).toContain('"label":"Ada"');
    expect(JSON.stringify(untidy)).toContain('"  Ada "');
    expect(validateValues([field], { link: { ...value, label: " Ada " } })).toEqual({ link: value });
  });

  it("leaves a block the schema can't read alone", () => {
    const old = [{ ...card, v: 9, value: { link: { ...value, label: " x " } } }];
    expect(normalizeBlocks(old, catalog)).toEqual(old);
  });

  it("is searchable through its own function, at any depth", () => {
    expect(searchText([{ name: "s", type: "stream", config: { searchable: true } }], { s: nested }, catalog as never)).toBe("Ada");
  });

  it("summarizes for the grid and revision diffs", () => {
    expect(valueSummary(field, value)).toBe("Ada (#7)");
    expect(diffValues([{ id: 1, ...field }], { 1: { ...value, id: 8 } }, { 1: value })[0]).toMatchObject({ beforeSummary: "Ada (#8)", afterSummary: "Ada (#7)" });
  });

  it("has a custom control and limits filter operators", () => {
    expect(editorInput("acme_link")).toBe("custom");
    expect(fieldCatalogue().find((type) => type.type === "acme_link")?.input).toBe("custom");
    const columns = new Map([["link", "json"], ["title", "text"]]);
    const limits = new Map([["link", fieldOperators("acme_link")!]]);
    expect(validateFilter('link = "x"', columns, limits)).toBeNull();
    expect(validateFilter('link != "x"', columns, limits)).toMatch(/can't be filtered/);
    expect(validateFilter('title != "x" || link ~ "x"', columns, limits)).toMatch(/can't be filtered/);
    expect(validateFilter('title != "x"', columns, limits)).toBeNull();
  });
});

describe("a field whose hooks misbehave", () => {
  const bad = { name: "b", type: "acme_broken", config: {} };

  it("can't be saved when its links can't be read", () => {
    expect(() => validateValues([bad], { b: {} })).toThrow();
    const blockCatalog: BlockCatalog = new Map([["x", { name: "x", version: 1, fields: [bad] }]]);
    expect(streamIssues("s", [{ id: "1", type: "x", v: 1, value: { b: {} } }], null, blockCatalog)).toEqual([{ path: "s.0.value.b", message: "Bad link." }]);
  });

  it("can't declare more links than a reference field may hold", () => {
    expect(() => validateValues([{ name: "m", type: "acme_many", config: {} }], { m: 1 })).toThrow();
  });

  it("never breaks a read", () => {
    expect(valueRefs(bad, {})).toEqual({ records: [], files: [] });
    expect(valueSummary(bad, {})).toBeUndefined();
    expect(searchText([{ name: "b", type: "acme_broken", config: { searchable: true } }], { b: {} }, new Map())).toBe("");
  });
});

describe("rendering", () => {
  const Plugin = () => createElement("i", null, "plugin");
  const Mine = (props: BlockProps) => createElement("b", null, String(props.block.id));
  const Fallback = () => createElement("u", null, "fallback");
  const renderers = defineRenderers({ blocks: { card: Plugin } });
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(StreamField, { blocks: [card], ...props } as never));

  it("prefers components passed in, then the plugin's default, then fallback", () => {
    expect(render({ components: { card: Mine }, renderers, fallback: Fallback })).toBe("<b>c</b>");
    expect(render({ renderers, fallback: Fallback })).toBe("<i>plugin</i>");
    expect(render({ fallback: Fallback })).toBe("<u>fallback</u>");
    expect(render({})).toBe("");
  });

  it("refuses two plugins rendering the same block", () => {
    expect(() => mergeRenderers([renderers, renderers])).toThrow(/Two plugins render "card"/);
  });
});

describe("showIf", () => {
  const shown = (rule: unknown, values: Record<string, unknown>) => isShown({ showIf: rule }, (name) => values[name]);
  it("shows on a value, or an exact one", () => {
    expect(isShown(null, () => undefined)).toBe(true);
    expect(shown({ field: "a" }, { a: "x" })).toBe(true);
    expect(shown({ field: "a" }, {})).toBe(false);
    expect(shown({ field: "a", equals: "x" }, { a: "y" })).toBe(false);
    expect(shown({ field: "a", equals: "x" }, { a: "x" })).toBe(true);
  });
});

describe("versioned field types", () => {
  const versioned = (version: number, upgrade?: Record<number, (value: unknown) => unknown>) => defineField({ type: "acme_v", admin: { label: "V", input: "json" }, config: {}, value: () => z.object({ n: z.number() }), version, upgrade, storage: () => ({ sql: "json" }) });

  it("needs a step for every version it has been", () => {
    expect(() => buildRegistry([versioned(3, { 1: (value) => value })])).toThrow(/no upgrade step from version 2/);
    expect(() => buildRegistry([versioned(0)])).toThrow(/whole number/);
    expect(() => buildRegistry([versioned(2, { 1: (value) => value })])).not.toThrow();
  });

  it("reaches every value of the type at any depth, on a copy", () => {
    const changed = mapFieldValues(nested, catalog, "acme_link", (_, value) => ({ ...(value as object), label: "New" }));
    expect(JSON.stringify(changed)).toContain('"label":"New"');
    expect(JSON.stringify(nested)).toContain('"label":"Ada"');
  });

  it("is checked by the test kit", () => {
    const good = versioned(2, { 1: (value) => ({ n: value }) });
    expect(testFieldDefinition(good, { valid: [{ n: 1 }], upgrades: [{ from: 1, value: 5, expected: { n: 5 } }] })).toEqual([]);
    expect(testFieldDefinition(good, { valid: [], upgrades: [{ from: 1, value: 5, expected: { n: 6 } }] })[0]).toMatch(/expected/);
    expect(testFieldDefinition(versioned(2, { 1: () => "no" }), { valid: [], upgrades: [{ from: 1, value: 5 }] })[0]).toMatch(/invalid/);
  });
});

describe("inserting a saved layout", () => {
  it("gives every block a new id at any depth, and leaves other lists alone", () => {
    const inserted = withFreshIds([{ id: "a", type: "t", v: 1, value: { tags: ["x"], inner: [{ id: "b", type: "t", v: 1, value: {} }] } }]);
    expect(inserted[0].id).not.toBe("a");
    expect(inserted[0].value.tags).toEqual(["x"]);
    expect((inserted[0].value.inner as Array<{ id: string }>)[0].id).not.toBe("b");
  });
});

describe("testFieldDefinition", () => {
  it("passes a sound definition", () => {
    expect(testFieldDefinition(link, { valid: [value, { ...value, label: " Ada " }], invalid: [{ label: "", id: 1 }, "x"], refs: [{ value, expected: { records: [{ collection: "people", id: 7 }], files: ["file-1"] } }] })).toEqual([]);
  });

  it("finds what a plugin author got wrong", () => {
    const wrongColumn = defineField({ type: "x_a", admin: { label: "A", input: "json" }, config: {}, value: () => z.object({}).loose(), storage: () => ({ sql: "text" }) });
    expect(testFieldDefinition(wrongColumn, { valid: [{}] })[0]).toMatch(/isn't text/);
    const unstable = defineField({ type: "x_b", admin: { label: "B", input: "text" }, config: {}, value: () => z.string(), normalize: (input) => `${String(input)}!`, storage: () => ({ sql: "text" }) });
    expect(testFieldDefinition(unstable, { valid: ["a"] })[0]).toMatch(/a second time/);
    const nul = defineField({ type: "x_c", admin: { label: "C", input: "text" }, config: {}, value: () => z.string(), storage: () => ({ sql: "text" }) });
    expect(testFieldDefinition(nul, { valid: ["a\u0000"] })[0]).toMatch(/NUL/);
    expect(testFieldDefinition(link, { valid: [], invalid: [value] })[0]).toMatch(/accepts/);
    expect(testFieldDefinition(link, { valid: [], refs: [{ value, expected: {} }] })[0]).toMatch(/refs of/);
  });
});
