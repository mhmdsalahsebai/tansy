import { describe, expect, it } from "vitest";
import type { Block } from "@/core/blocks/limits";
import type { BlockTypeInfo, EditorCatalog } from "@/components/fields/types";
import {
  addableTypes, blockSummary, canAdd, defaultBlockType, duplicateAt, insertAt, matchesQuery, moveTo, placement, removeAt, typedValue,
} from "@/components/stream/stream-ops";

const fieldType = (type: string, input: string) => ({ type, label: type, input, configSchema: {} }) as EditorCatalog["fieldTypes"][number];
const blockType = (name: string, fields: BlockTypeInfo["fields"], extra: Partial<BlockTypeInfo> = {}): BlockTypeInfo => ({ id: 1, name, label: name, version: 1, fields, ...extra });

const heading = blockType("heading", [{ name: "text", type: "text" }, { name: "level", type: "radio" }]);
const paragraph = blockType("paragraph", [{ name: "body", type: "rich_text" }]);
const quote = blockType("quote", [{ name: "text", type: "text", config: { multiline: true } }, { name: "source", type: "text" }]);
const note = blockType("note", [{ name: "text", type: "text", config: { multiline: true } }]);
const divider = blockType("divider", [{ name: "style", type: "radio" }], { category: "Layout" });
const catalog: EditorCatalog = {
  fieldTypes: [fieldType("text", "text"), fieldType("rich_text", "richtext"), fieldType("radio", "select"), fieldType("stream", "stream")],
  blockTypes: [heading, paragraph, quote, note, divider],
};

const block = (id: string, type: string, value: Record<string, unknown> = {}): Block => ({ id, type, v: 1, value });

describe("stream operations", () => {
  it("insert, remove and move without changing the original list", () => {
    const list = [block("a", "x"), block("b", "x"), block("c", "x")];
    expect(insertAt(list, 1, [block("n", "x")]).map((item) => item.id)).toEqual(["a", "n", "b", "c"]);
    expect(removeAt(list, 0).map((item) => item.id)).toEqual(["b", "c"]);
    expect(moveTo(list, 2, 0).map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(moveTo(list, 0, 5)).toBe(list);
    expect(list.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("duplicates a block with new ids at every depth, keeping its content", () => {
    const list = [block("a", "callout", { title: "Hi", content: [block("inner", "paragraph", { body: "x" })] })];
    const [original, copy] = duplicateAt(list, 0);
    expect(original).toBe(list[0]);
    expect(copy.id).not.toBe("a");
    expect(copy.value.title).toBe("Hi");
    const inner = (copy.value.content as Block[])[0];
    expect(inner.id).not.toBe("inner");
    expect(inner.value).toEqual({ body: "x" });
  });

  it("offers only the types a list can still take", () => {
    const list = [block("a", "heading")];
    expect(addableTypes(list, { allowedBlocks: ["heading", "paragraph"] }, catalog).map((type) => type.name)).toEqual(["heading", "paragraph"]);
    expect(addableTypes(list, { blockLimits: { heading: 1 } }, catalog).map((type) => type.name)).not.toContain("heading");
    expect(addableTypes(list, { max: 1 }, catalog)).toEqual([]);
  });

  it("checks a duplicate or layout against the list's limits", () => {
    const list = [block("a", "heading")];
    expect(canAdd(list, [block("b", "heading")], {})).toBe(true);
    expect(canAdd(list, [block("b", "heading")], { max: 1 })).toBe(false);
    expect(canAdd(list, [block("b", "heading")], { blockLimits: { heading: 1 } })).toBe(false);
    expect(canAdd(list, [block("b", "quote")], { allowedBlocks: ["heading"] })).toBe(false);
  });

  it("puts content on the canvas and settings in the sidebar", () => {
    expect(placement("richtext", null, "block")).toBe("canvas");
    expect(placement("text", null, "block")).toBe("canvas");
    expect(placement("image", null, "block")).toBe("canvas");
    expect(placement("select", null, "block")).toBe("settings");
    expect(placement("boolean", null, "record")).toBe("settings");
    // A record's one-line text, such as a slug, and its single image are details.
    expect(placement("text", null, "record")).toBe("settings");
    expect(placement("text", { multiline: true }, "record")).toBe("canvas");
    expect(placement("image", null, "record")).toBe("settings");
    expect(placement("stream", null, "record")).toBe("canvas");
  });

  it("starts typing in a rich text block, then a multi-line text one, never a heading", () => {
    expect(defaultBlockType(catalog.blockTypes, catalog)?.name).toBe("paragraph");
    expect(defaultBlockType([heading, quote, note], catalog)?.name).toBe("note");
    expect(defaultBlockType([heading, quote, divider], catalog)).toBeUndefined();
  });

  it("puts typed text into a block's content field", () => {
    expect(typedValue(paragraph, catalog, "Hi")).toEqual({ body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] } });
    expect(typedValue(note, catalog, "Hi")).toEqual({ text: "Hi" });
  });

  it("summarises a block from its text or rich text", () => {
    expect(blockSummary(block("a", "quote", { text: "  Words  ", source: "x" }))).toBe("Words");
    expect(blockSummary(block("a", "paragraph", { body: typedValue(paragraph, catalog, "Rich words").body }))).toBe("Rich words");
    expect(blockSummary(block("a", "divider", { style: 3 }))).toBe("");
  });

  it("matches a search on label, name or category", () => {
    expect(matchesQuery(divider, "lay")).toBe(true);
    expect(matchesQuery(divider, "div lay")).toBe(true);
    expect(matchesQuery(divider, "quote")).toBe(false);
  });
});
