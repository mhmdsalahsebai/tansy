/**
 * Markdown to the rich text format, for text an AI model or an import writes. Covers what
 * rich text can hold: headings, paragraphs, lists, quotes, code blocks, rules, bold,
 * italic, strikethrough, inline code and links. Anything else stays as plain text, and
 * links that aren't http, https or mailto become their text. No server or browser imports.
 */
import { safeHref, type RichNode } from "./rich-text";

const MAX_INPUT = 200_000;

type Mark = { type: string; attrs?: Record<string, unknown> };

const INLINE = /(\*\*|__)(.+?)\1|(\*|_)(?=\S)(.+?)(?<=\S)\3|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/;

function inline(text: string, marks: Mark[] = []): RichNode[] {
  const nodes: RichNode[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) {
      nodes.push(textNode(rest, marks));
      break;
    }
    if (match.index > 0) nodes.push(textNode(rest.slice(0, match.index), marks));
    const [, , bold, , italic, strike, code, label, href] = match;
    if (bold !== undefined) nodes.push(...inline(bold, [...marks, { type: "bold" }]));
    else if (italic !== undefined) nodes.push(...inline(italic, [...marks, { type: "italic" }]));
    else if (strike !== undefined) nodes.push(...inline(strike, [...marks, { type: "strike" }]));
    else if (code !== undefined) nodes.push(textNode(code, [...marks, { type: "code" }]));
    else {
      const safe = safeHref(href);
      nodes.push(...inline(label, safe ? [...marks, { type: "link", attrs: { href: safe } }] : marks));
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return nodes.filter((node) => node.text);
}

const textNode = (text: string, marks: Mark[]): RichNode => (marks.length ? { type: "text", text, marks: marks.map((mark) => ({ ...mark })) } : { type: "text", text });

const paragraph = (lines: string[]): RichNode => {
  const content: RichNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...inline(line.trim()));
  });
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function list(lines: string[], start: number): [RichNode, number] {
  const ordered = /\d/.test(LIST_ITEM.exec(lines[start])![2]);
  const items: RichNode[] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match || /\d/.test(match[2]) !== ordered) break;
    items.push({ type: "listItem", content: [paragraph([match[3]])] });
    index++;
  }
  return [{ type: ordered ? "orderedList" : "bulletList", content: items }, index];
}

function blocks(lines: string[]): RichNode[] {
  const out: RichNode[] = [];
  let index = 0;
  let open: string[] = [];
  const flush = () => {
    if (open.length) out.push(paragraph(open));
    open = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^```/.test(line.trim());
    if (fence) {
      flush();
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index].trim())) body.push(lines[index++]);
      index++;
      out.push(body.length ? { type: "codeBlock", content: [{ type: "text", text: body.join("\n") }] } : { type: "codeBlock" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      flush();
      const content = inline(heading[2].replace(/\s+#+$/, ""));
      out.push({ type: "heading", attrs: { level: heading[1].length }, ...(content.length ? { content } : {}) });
      index++;
      continue;
    }
    if (/^(\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)[\s*_-]*$/.test(line.trim())) {
      flush();
      out.push({ type: "horizontalRule" });
      index++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const [node, next] = list(lines, index);
      out.push(node);
      index = next;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quoted.push(lines[index++].replace(/^>\s?/, ""));
      const content = blocks(quoted);
      out.push({ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] });
      continue;
    }
    if (!line.trim()) flush();
    else open.push(line);
    index++;
  }
  flush();
  return out;
}

/** A rich text document from Markdown. Empty text gives a document with one empty paragraph. */
export function markdownToRichText(markdown: string): RichNode {
  const content = blocks(markdown.slice(0, MAX_INPUT).replace(/\r\n?/g, "\n").split("\n"));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
