import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { upgradeBlocks, type Block, type BlockCatalog } from "@/core/blocks/stream";
import { resolveFieldConfig } from "@/core/fields/registry";
import { plainText, richTextProblem, safeHref, type RichNode } from "@/core/fields/rich-text";
import { validateValues } from "@/core/fields/validate";
import { HttpError } from "@/core/http/errors";
import { RichText, StreamField, type BlockProps } from "@/components/stream/StreamField";

const link = (href: string): RichNode => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] }] });
const html = (doc: unknown) => renderToStaticMarkup(createElement(RichText, { doc }));

describe("rich text validation", () => {
  const stream = (nodes: unknown[]) => ({ type: "doc", content: nodes as RichNode[] });

  it("accepts the editor's formats", () => {
    expect(richTextProblem(stream([{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T", marks: [{ type: "bold" }] }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }]))).toBeNull();
  });
  it("refuses HTML, unknown nodes and marks, and bad headings", () => {
    expect(richTextProblem("<b>x</b>")).not.toBeNull();
    expect(richTextProblem(stream([{ type: "iframe" }]))).not.toBeNull();
    expect(richTextProblem(stream([{ type: "text", text: "x", marks: [{ type: "onclick" }] }]))).not.toBeNull();
    expect(richTextProblem(stream([{ type: "heading", attrs: { level: 9 } }]))).not.toBeNull();
  });
  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html,x", "vbscript:x", "/relative", ""])("refuses the link %j", (href) => {
    expect(richTextProblem(link(href))).toMatch(/Links must/);
  });
  it("accepts ordinary links", () => {
    expect(richTextProblem(link("https://example.com/a?b=1"))).toBeNull();
    expect(richTextProblem(link("mailto:a@example.com"))).toBeNull();
  });
  it("caps nesting", () => {
    let node: RichNode = { type: "paragraph" };
    for (let i = 0; i < 40; i++) node = { type: "blockquote", content: [node] };
    expect(richTextProblem({ type: "doc", content: [node] })).toMatch(/too deeply/);
  });
  it("enforces allowedFeatures through the field", () => {
    const resolved = resolveFieldConfig("rich_text", { allowedFeatures: ["bold"] });
    if (!resolved.ok) throw new Error("config");
    const field = { name: "f", type: "rich_text", config: resolved.config };
    const refused = (value: unknown) => {
      try {
        validateValues([field], { f: value });
        return false;
      } catch (error) {
        return error instanceof HttpError;
      }
    };
    expect(refused(stream([{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }] }]))).toBe(false);
    expect(refused(stream([{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "italic" }] }] }]))).toBe(true);
    expect(refused(stream([{ type: "blockquote" }]))).toBe(true);
  });
  it("extracts plain text", () => {
    expect(plainText(stream([{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, { type: "paragraph", content: [{ type: "text", text: "c" }] }]))).toBe("ab c");
  });
});

describe("rich text rendering", () => {
  it("renders elements and marks", () => {
    expect(html({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T" }] }, { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "italic" }] }] }] })).toBe("<h2>T</h2><p><em><strong>x</strong></em></p>");
  });
  it("escapes text rather than treating it as HTML", () => {
    expect(html({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] }] })).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });
  it("drops unsafe links and unknown nodes even if they reached storage", () => {
    expect(html(link("javascript:alert(1)"))).toBe("<p>x</p>");
    expect(html({ type: "doc", content: [{ type: "script", content: [{ type: "text", text: "x" }] }] })).toBe("");
    expect(html(link("https://example.com/"))).toContain('rel="noopener noreferrer nofollow"');
  });
  it("keeps a stored heading level in range", () => {
    expect(html({ type: "doc", content: [{ type: "heading", attrs: { level: "script" } }] })).toBe("<h2></h2>");
  });
});

describe("StreamField", () => {
  const Heading = ({ value }: BlockProps) => createElement("h2", null, String(value.text));
  const Section = ({ value, components }: BlockProps) => createElement("section", null, createElement(StreamField, { blocks: value.body, components }));
  const components = { heading: Heading, section: Section };
  const render = (blocks: unknown, extra = {}) => renderToStaticMarkup(createElement(StreamField, { blocks, components, ...extra }));
  const heading = (id: string, text: string): Block => ({ id, type: "heading", v: 1, value: { text } });

  it("renders blocks in order, nested two levels deep", () => {
    const blocks = [heading("a", "First"), { id: "s", type: "section", v: 1, value: { body: [{ id: "t", type: "section", v: 1, value: { body: [heading("b", "Deep")] } }] } }];
    expect(render(blocks)).toBe("<h2>First</h2><section><section><h2>Deep</h2></section></section>");
  });
  it("skips blocks with no component, or uses the fallback", () => {
    const blocks = [{ id: "x", type: "retired", v: 1, value: {} }];
    expect(render(blocks)).toBe("");
    expect(render(blocks, { fallback: () => createElement("i", null, "unavailable") })).toBe("<i>unavailable</i>");
  });
  it("won't resolve a block type to an inherited property", () => {
    expect(render([{ id: "x", type: "constructor", v: 1, value: {} }])).toBe("");
  });
  it("ignores values that aren't lists", () => {
    expect(render("nope")).toBe("");
  });
});

describe("block upgrades", () => {
  const field = (name: string, type: string) => {
    const resolved = resolveFieldConfig(type, {});
    if (!resolved.ok) throw new Error("config");
    return { name, type, config: resolved.config };
  };
  const catalog: BlockCatalog = new Map([
    ["hero", { name: "hero", version: 3, fields: [field("title", "text")] }],
    ["section", { name: "section", version: 1, fields: [field("body", "stream")] }],
  ]);
  const hero = (v: number, value: Record<string, unknown>): Block => ({ id: "h", type: "hero", v, value });
  const upgrades = { hero: { 1: (value: Record<string, unknown>) => ({ heading: value.name }), 2: (value: Record<string, unknown>) => ({ title: value.heading }) } };

  it("applies each step up to the current version", () => {
    expect(upgradeBlocks([hero(1, { name: "x" })], catalog, upgrades)).toEqual([hero(3, { title: "x" })]);
  });
  it("reaches nested blocks", () => {
    const nested: Block = { id: "s", type: "section", v: 1, value: { body: [hero(2, { heading: "y" })] } };
    expect(upgradeBlocks([nested], catalog, upgrades)[0].value.body).toEqual([hero(3, { title: "y" })]);
  });
  it("leaves the block as stored when a step is missing or throws", () => {
    const old = hero(1, { name: "x" });
    expect(upgradeBlocks([old], catalog, { hero: { 1: upgrades.hero[1] } })).toEqual([old]);
    expect(upgradeBlocks([old], catalog, { hero: { 1: () => { throw new Error("boom"); }, 2: upgrades.hero[2] } })).toEqual([old]);
  });
  it("leaves current and unknown blocks alone", () => {
    const current = hero(3, { title: "x" });
    const unknown: Block = { id: "u", type: "retired", v: 1, value: { a: 1 } };
    expect(upgradeBlocks([current, unknown], catalog, upgrades)).toEqual([current, unknown]);
  });
  it("is not fooled by an inherited step or block name", () => {
    const block: Block = { id: "x", type: "constructor", v: 1, value: {} };
    expect(upgradeBlocks([block], catalog, upgrades)).toEqual([block]);
  });
});

it("safeHref normalizes what it allows", () => {
  expect(safeHref("HTTPS://Example.com")).toBe("https://example.com/");
  expect(safeHref(42)).toBeNull();
});
