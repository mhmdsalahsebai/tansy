import { describe, expect, it } from "vitest";
import { pluginCanOwn } from "@/core/blocks/service";
import { MAX_BLOCK_DEPTH, streamIssues, streamRefs, type Block, type BlockCatalog } from "@/core/blocks/stream";
import { resolveFieldConfig } from "@/core/fields/registry";
import { validateValues } from "@/core/fields/validate";
import { HttpError } from "@/core/http/errors";

const field = (name: string, type: string, raw: Record<string, unknown> = {}) => {
  const resolved = resolveFieldConfig(type, raw);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
  return { name, type, config: resolved.config };
};

const catalog: BlockCatalog = new Map([
  ["heading", { name: "heading", version: 2, fields: [field("text", "text", { required: true, maxLength: 10 }), field("link", "url")] }],
  ["author", { name: "author", version: 1, fields: [field("person", "reference", { collection: 7 }), field("others", "reference", { collection: 8, allowMultiple: true })] }],
  ["section", { name: "section", version: 1, fields: [field("body", "stream")] }],
]);

const heading = (id: string, text: unknown = "Hi", v = 2): Block => ({ id, type: "heading", v, value: { text } });
const section = (id: string, body: Block[]): Block => ({ id, type: "section", v: 1, value: { body } });
const issues = (blocks: Block[], stored?: unknown) => streamIssues("body", blocks, stored, catalog);
const paths = (blocks: Block[], stored?: unknown) => issues(blocks, stored).map((issue) => issue.path);

describe("a block whose field's plugin was removed", () => {
  const orphaned: BlockCatalog = new Map([["promo", { name: "promo", version: 1, fields: [{ name: "x", type: "gone_type", config: {} }] }]]);
  const promo = (x: unknown): Block => ({ id: "p1", type: "promo", v: 1, value: { x } });
  const check = (blocks: Block[], stored?: unknown) => streamIssues("body", blocks, stored, orphaned);

  it("is kept as stored", () => {
    expect(check([promo(1)], [promo(1)])).toEqual([]);
  });

  it("can't be changed or added", () => {
    expect(check([promo(2)], [promo(1)])[0].message).toBe("A plugin this block needs is not installed.");
    expect(check([promo(1)])).toHaveLength(1);
  });
});

describe("stream envelope", () => {
  const accepts = (raw: Record<string, unknown>, value: unknown) => {
    try {
      validateValues([field("f", "stream", raw)], { f: value });
      return true;
    } catch (error) {
      if (error instanceof HttpError) return false;
      throw error;
    }
  };

  it("takes well-formed blocks and refuses anything else", () => {
    expect(accepts({}, [heading("a")])).toBe(true);
    expect(accepts({}, "text")).toBe(false);
    expect(accepts({}, [{ id: "a", type: "heading", v: 1 }])).toBe(false);
    expect(accepts({}, [{ ...heading("a"), extra: 1 }])).toBe(false);
    expect(accepts({}, [heading("bad id")])).toBe(false);
    expect(accepts({}, [{ ...heading("a"), type: "Bad-Type" }])).toBe(false);
  });
  it("enforces allowed blocks, list size and per-block limits", () => {
    expect(accepts({ allowedBlocks: ["section"] }, [heading("a")])).toBe(false);
    expect(accepts({ min: 2 }, [heading("a")])).toBe(false);
    expect(accepts({ max: 1 }, [heading("a"), heading("b")])).toBe(false);
    expect(accepts({ blockLimits: { heading: 1 } }, [heading("a"), heading("b")])).toBe(false);
  });
  it("cannot be unique", () => {
    expect(resolveFieldConfig("stream", { unique: true }).ok).toBe(false);
  });
});

describe("recursive validation", () => {
  it("accepts valid blocks at any level", () => {
    expect(issues([heading("a"), section("b", [heading("c")])])).toEqual([]);
  });
  it("reports paths the editor can target", () => {
    expect(paths([section("s", [heading("a"), heading("b", "much too long a heading")])])).toEqual(["body.0.value.body.1.value.text"]);
  });
  it("requires required fields and refuses undeclared ones", () => {
    expect(paths([{ id: "a", type: "heading", v: 2, value: {} }])).toEqual(["body.0.value.text"]);
    expect(paths([{ id: "a", type: "heading", v: 2, value: { text: "x", extra: 1 } }])).toEqual(["body.0.value.extra"]);
  });
  it("is not fooled by inherited property names", () => {
    const dangerous = JSON.parse('{"id":"a","type":"heading","v":2,"value":{"text":"x","__proto__":{"admin":true}}}') as Block;
    expect(paths([dangerous])).toEqual(["body.0.value.__proto__"]);
  });
  it("applies each field's own rules inside blocks", () => {
    expect(paths([{ id: "a", type: "heading", v: 2, value: { text: "x", link: "javascript:alert(1)" } }])).toEqual(["body.0.value.link"]);
  });
  it("refuses a repeated block id across levels", () => {
    expect(paths([heading("a"), section("b", [heading("a")])])).toEqual(["body.1.value.body.0.id"]);
  });
  it("caps nesting depth", () => {
    const nest = (levels: number): Block => section(`s${levels}`, levels > 1 ? [nest(levels - 1)] : []);
    expect(issues([nest(MAX_BLOCK_DEPTH)])).toEqual([]);
    expect(issues([nest(MAX_BLOCK_DEPTH + 1)])[0].message).toMatch(/nest at most/);
  });
});

describe("blocks the current schema can't read", () => {
  const removed: Block = { id: "gone", type: "retired", v: 3, value: { anything: "kept" } };

  it("keeps a removed type's block when it is unchanged", () => {
    expect(issues([removed], [removed])).toEqual([]);
    expect(issues([section("s", [removed])], [section("s", [removed])])).toEqual([]);
  });
  it("keeps an old version when it is unchanged, even if it wouldn't validate today", () => {
    const old = heading("a", "a heading longer than the limit", 1);
    expect(issues([old], [old])).toEqual([]);
  });
  it("won't create or alter one, so validation can't be skipped", () => {
    expect(paths([removed])).toEqual(["body.0.type"]);
    expect(paths([{ ...removed, value: { anything: "changed" } }], [removed])).toEqual(["body.0.type"]);
    expect(paths([heading("a", "<script>", 1)])).toEqual(["body.0.type"]);
    expect(paths([heading("a", "x", 3)], [heading("a", "x", 2)])).toEqual(["body.0.type"]);
  });
  it("can't be smuggled in through a JSON value stored in a block", () => {
    const withJson: BlockCatalog = new Map([...catalog, ["data", { name: "data", version: 1, fields: [field("raw", "json")] }]]);
    const planted = heading("x", "<not validated>", 1);
    const stored: Block[] = [{ id: "d", type: "data", v: 1, value: { raw: [planted] } }];
    expect(streamIssues("body", [planted], stored, withJson).map((issue) => issue.path)).toEqual(["body.0.type"]);
  });
});

describe("reference index", () => {
  it("finds single and multiple links at any level", () => {
    const blocks = [section("s", [{ id: "a", type: "author", v: 1, value: { person: 1, others: [2, 3] } }])];
    expect(streamRefs(blocks, catalog).refs).toEqual([
      { blockId: "a", targetCollectionId: 7, targetRecordId: 1 },
      { blockId: "a", targetCollectionId: 8, targetRecordId: 2 },
      { blockId: "a", targetCollectionId: 8, targetRecordId: 3 },
    ]);
  });
  it("marks unreadable blocks and their children so their links are kept", () => {
    const old: Block = { id: "old", type: "retired", v: 1, value: { inner: [{ id: "child", type: "author", v: 1, value: { person: 1 } }] } };
    const { refs, opaque } = streamRefs([old], catalog);
    expect(refs).toEqual([]);
    expect([...opaque].sort()).toEqual(["child", "old"]);
  });
});

describe("who may own a block's name", () => {
  it("is the plugin that created it, or nobody if the block has an owner of its own", () => {
    expect(pluginCanOwn({ source: "seo", createdById: null }, "seo")).toBe(true);
    expect(pluginCanOwn({ source: "other", createdById: null }, "seo")).toBe(false);
    expect(pluginCanOwn({ source: null, createdById: "user-1" }, "seo")).toBe(false);
  });

  it("includes a block with no author, from an earlier version or a replayed schema file", () => {
    expect(pluginCanOwn({ source: null, createdById: null }, "seo")).toBe(true);
  });
});
