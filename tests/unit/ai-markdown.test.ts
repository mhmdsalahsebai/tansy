import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown, parseBlocks, safeHref } from "../../plugins/ai/markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("the assistant's Markdown", () => {
  it("reads blocks", () => {
    expect(parseBlocks("# Title\n\nSome text\nmore\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n---\n\n```ts\nconst a = 1;\n```").map((block) => block.kind))
      .toEqual(["heading", "paragraph", "list", "list", "quote", "rule", "code"]);
  });

  it("runs an unclosed fence to the end, as while streaming", () => {
    expect(parseBlocks("```js\nlet x")).toEqual([{ kind: "code", language: "js", text: "let x" }]);
  });

  it("renders inline marks", () => {
    expect(html("**bold** and *it* and `code` and [site](https://example.com)")).toBe('<p><strong>bold</strong> and <em>it</em> and <code>code</code> and <a href="https://example.com" target="_blank" rel="noreferrer noopener">site</a></p>');
  });

  it("never renders markup or unsafe links", () => {
    expect(html("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(html("[x](javascript:alert(1))")).not.toContain("href");
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/dashboard")).toBe("/dashboard");
  });
});
