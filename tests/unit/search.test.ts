import { describe, expect, it } from "vitest";
import { isIndexed, postgresQuery, searchSignature, searchText, searchWords, sqliteQuery } from "@/core/search/extract";

const on = { searchable: true };

describe("search text", () => {
  it("takes text from searchable fields, rich text and nested blocks", () => {
    const catalog = new Map([["note", { fields: [{ name: "text", type: "text" }, { name: "inner", type: "stream" }, { name: "photo", type: "image" }] }]]);
    const fields = [{ name: "title", type: "text", config: on }, { name: "rich", type: "rich_text", config: on }, { name: "body", type: "stream", config: on }, { name: "skip", type: "text" }];
    const row = {
      title: "plain", skip: "ignored",
      rich: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "formatted" }] }] },
      body: [{ id: "a", type: "note", v: 1, value: { text: "outer", photo: "file_abc", inner: [{ id: "b", type: "note", v: 1, value: { text: "nested" } }] } }, { id: "c", type: "gone", v: 1, value: { text: "unknown block" } }],
    };
    expect(searchText(fields, row, catalog).split("\n")).toEqual(["plain", "formatted", "outer", "nested"]);
  });
  it("never indexes a hidden field, so it can't be probed", () => {
    expect(isIndexed({ name: "s", type: "text", config: { searchable: true, hidden: true } })).toBe(false);
    expect(searchText([{ name: "s", type: "text", config: { searchable: true, hidden: true } }], { s: "secret" }, new Map())).toBe("");
  });
  it("skips fields holding ids, dates and numbers", () => expect(searchText([{ name: "f", type: "file", config: on }, { name: "r", type: "reference", config: on }], { f: "file_1", r: 3 }, new Map())).toBe(""));
  it("notices only changes that affect the index", () => {
    const before = [{ name: "a", type: "text", config: on }, { name: "b", type: "text" }];
    expect(searchSignature([...before])).toBe(searchSignature(before));
    expect(searchSignature([{ name: "a", type: "text", config: { searchable: false } }, before[1]])).not.toBe(searchSignature(before));
  });
});

describe("search queries", () => {
  it.each(['" OR 1=1 --', "a) | b:* & !c", "NEAR(x y)", "col:value*", "'; DROP TABLE x; --"])("reduce %s to plain words", (raw) => {
    for (const word of searchWords(raw)) expect(word).toMatch(/^[\p{L}\p{N}]+$/u);
  });
  it("cap the number of words", () => expect(searchWords("a ".repeat(100))).toHaveLength(20));
  it("match the last word as a prefix", () => {
    expect(sqliteQuery(["foo", "ba"])).toBe('"foo" "ba"*');
    expect(postgresQuery(["foo", "ba"])).toBe("foo & ba:*");
  });
  it("keep non-English words whole", () => expect(searchWords("مرحبا café 日本語")).toEqual(["مرحبا", "café", "日本語"]));
});
