import { describe, expect, it } from "vitest";
import { diffBlocks, diffValues } from "@/core/content/diff";

const block = (id: string, text = id, type = "para") => ({ id, type, v: 1, value: { text } });
const summary = (changes: ReturnType<typeof diffBlocks>) => changes.map((c) => `${c.id}:${c.change}`).sort();

describe("diffBlocks", () => {
  it("reports nothing for identical blocks", () => {
    expect(diffBlocks([block("a"), block("b")], [block("a"), block("b")])).toEqual([]);
  });
  it("tells additions, removals and edits apart", () => {
    const changes = diffBlocks([block("a"), block("b")], [block("a", "edited"), block("c")]);
    expect(summary(changes)).toEqual(["a:changed", "b:removed", "c:added"]);
    expect(changes.find((c) => c.id === "a")!.fields).toEqual([{ name: "text", before: "a", after: "edited" }]);
  });
  it("reports only the block that moved", () => {
    expect(summary(diffBlocks([block("a"), block("b"), block("c"), block("d")], [block("b"), block("c"), block("d"), block("a")]))).toEqual(["a:moved"]);
  });
  it("doesn't count blocks shifted by an insert or removal as moved", () => {
    expect(summary(diffBlocks([block("a"), block("b")], [block("new"), block("a"), block("b")]))).toEqual(["new:added"]);
    expect(summary(diffBlocks([block("x"), block("a"), block("b")], [block("a"), block("b")]))).toEqual(["x:removed"]);
  });
  it("compares nested streams block by block", () => {
    const outer = (inner: unknown[]) => ({ id: "o", type: "section", v: 1, value: { inner } });
    const [change] = diffBlocks([outer([block("a"), block("b")])], [outer([block("a", "new")])]);
    expect(change.change).toBe("changed");
    expect(summary(change.fields![0].blocks!)).toEqual(["a:changed", "b:removed"]);
  });
  it("handles block ids that are object keys", () => {
    expect(summary(diffBlocks([block("__proto__")], [block("__proto__", "x"), block("constructor")]))).toEqual(["__proto__:changed", "constructor:added"]);
  });
});

describe("diffValues", () => {
  const fields = [{ id: 1, name: "title", type: "text" }, { id: 2, name: "body", type: "stream" }];
  it("lists only changed fields", () => {
    expect(diffValues(fields, { 1: "a", 2: null }, { 1: "b", 2: null })).toEqual([{ fieldId: 1, name: "title", type: "text", before: "a", after: "b" }]);
    expect(diffValues(fields, { 1: "a" }, { 1: "a" })).toEqual([]);
  });
  it("treats no earlier snapshot as empty", () => {
    expect(diffValues(fields, null, { 1: "a" }).map((c) => c.before)).toEqual([null]);
  });
  it("compares stream fields by block, from empty too", () => {
    const [change] = diffValues(fields, { 2: null }, { 2: [block("a")] });
    expect(summary(change.blocks!)).toEqual(["a:added"]);
  });
  it("ignores values for fields that no longer exist", () => {
    expect(diffValues(fields, { 9: "old" }, { 9: "new" })).toEqual([]);
  });
  it("leaves malformed stream content as a plain change", () => {
    const [change] = diffValues(fields, { 2: "not blocks" }, { 2: [block("a")] });
    expect(change.blocks).toBeUndefined();
  });
});
