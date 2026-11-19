import { Fragment, type ReactNode } from "react";

/**
 * A small Markdown reader for the assistant's answers: headings, paragraphs, lists, quotes, rules, fenced code,
 * and inline bold, italic, code and links. It builds React elements and never sets HTML, so a model's answer
 * can't put markup or scripts on the page. Links keep only http, https, mailto and same-site paths.
 */

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "rule" };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Splits text into blocks. An unclosed fence, as while an answer is still streaming, runs to the end. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  const starts = (line: string) => FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || RULE.test(line) || QUOTE.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      blocks.push({ kind: "code", language: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); index += 1; continue; }
    if (RULE.test(line)) { blocks.push({ kind: "rule" }); index += 1; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) body.push(QUOTE.exec(lines[index++])![1]);
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (BULLET.test(line) || numbered) {
      const pattern = numbered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const match = pattern.exec(current);
        if (match) { items.push(match[match.length - 1]); index += 1; continue; }
        // An indented line, or a nested item of the other kind, carries on the item above.
        if (items.length && current.trim() && /^\s+/.test(current) && !FENCE.test(current)) { items[items.length - 1] += `\n${current.trim()}`; index += 1; continue; }
        break;
      }
      blocks.push({ kind: "list", ordered: Boolean(numbered), start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() && !(body.length && starts(lines[index]))) body.push(lines[index++]);
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

/** A link's address when it is safe to follow, or null. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (value.startsWith("#")) return value;
  return null;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g;

/** Inline Markdown as React nodes. */
export function inline(text: string, key = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const id = `${key}-${count++}`;
    const [, , code, strong, strongAlt, em, emAlt, label, href, bare] = match;
    if (code !== undefined) nodes.push(<code key={id}>{code.trim() ? code.replace(/^ (.*) $/, "$1") : code}</code>);
    else if (strong ?? strongAlt) nodes.push(<strong key={id}>{inline(strong ?? strongAlt, id)}</strong>);
    else if (em ?? emAlt) nodes.push(<em key={id}>{inline(em ?? emAlt, id)}</em>);
    else if (label !== undefined) {
      const safe = safeHref(href);
      nodes.push(safe ? <a key={id} href={safe} target={safe.startsWith("/") || safe.startsWith("#") ? undefined : "_blank"} rel="noreferrer noopener">{inline(label, id)}</a> : <Fragment key={id}>{inline(label, id)}</Fragment>);
    } else if (bare) nodes.push(<a key={id} href={bare} target="_blank" rel="noreferrer noopener">{bare}</a>);
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Inline text where single line breaks stay line breaks, as people expect in a chat. */
function lines(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((line, index) => (index ? [<br key={`${key}-br${index}`} />, ...inline(line, `${key}-${index}`)] : inline(line, `${key}-${index}`)));
}

export function Markdown({ text, renderCode }: { text: string; renderCode?: (code: string, language: string, key: string) => ReactNode }) {
  return (
    <>
      {parseBlocks(text).map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "heading": {
            const Tag = `h${Math.min(block.level + 1, 6)}` as "h2";
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case "paragraph": return <p key={key}>{lines(block.text, key)}</p>;
          case "quote": return <blockquote key={key}><Markdown text={block.text} renderCode={renderCode} /></blockquote>;
          case "rule": return <hr key={key} />;
          case "code": return renderCode ? renderCode(block.text, block.language, key) : <pre key={key}><code>{block.text}</code></pre>;
          case "list": {
            const items = block.items.map((item, at) => <li key={at}>{lines(item, `${key}-${at}`)}</li>);
            return block.ordered ? <ol key={key} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
        }
      })}
    </>
  );
}
