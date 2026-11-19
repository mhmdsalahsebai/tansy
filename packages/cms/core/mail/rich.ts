import { safeHref, type RichNode } from "../fields/rich-text";

/**
 * Rich text (the editor's TipTap document) as an email: HTML that mail clients show, with
 * inline styles only, and the same words as plain text. Unknown nodes and marks are dropped,
 * every string is escaped, and a link keeps only an http, https or mailto address. No server
 * or browser imports, so it's easy to test.
 */

const MAX_DEPTH = 32;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const children = (node: RichNode) => (Array.isArray(node.content) ? node.content.filter((child): child is RichNode => Boolean(child) && typeof child === "object") : []);

const HEADING_SIZES: Record<number, string> = { 1: "28px", 2: "22px", 3: "18px", 4: "16px", 5: "15px", 6: "14px" };

function inlineHtml(node: RichNode): string {
  if (node.type === "hardBreak") return "<br>";
  if (node.type !== "text" || typeof node.text !== "string") return "";
  let html = escapeHtml(node.text);
  for (const mark of Array.isArray(node.marks) ? node.marks : []) {
    switch (mark?.type) {
      case "bold": html = `<strong>${html}</strong>`; break;
      case "italic": html = `<em>${html}</em>`; break;
      case "underline": html = `<u>${html}</u>`; break;
      case "strike": html = `<s>${html}</s>`; break;
      case "code": html = `<code style="font-family:monospace;background:#f3f4f6;padding:0 3px">${html}</code>`; break;
      case "link": {
        const href = safeHref(mark.attrs?.href);
        if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
        break;
      }
    }
  }
  return html;
}

function blockHtml(node: RichNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const inner = () => children(node).map((child) => (child.type === "text" || child.type === "hardBreak" ? inlineHtml(child) : blockHtml(child, depth + 1))).join("");
  switch (node.type) {
    case "doc": return inner();
    case "paragraph": return `<p style="margin:0 0 16px">${inner()}</p>`;
    case "heading": {
      const level = [1, 2, 3, 4, 5, 6].includes(node.attrs?.level as number) ? (node.attrs!.level as number) : 2;
      return `<h${level} style="margin:24px 0 12px;font-size:${HEADING_SIZES[level]}">${inner()}</h${level}>`;
    }
    case "bulletList": return `<ul style="margin:0 0 16px;padding-left:24px">${inner()}</ul>`;
    case "orderedList": return `<ol style="margin:0 0 16px;padding-left:24px">${inner()}</ol>`;
    // A list item's paragraphs would add space under each line.
    case "listItem": return `<li>${inner().replace(/<p style="margin:0 0 16px">/g, "<p style=\"margin:0\">")}</li>`;
    case "blockquote": return `<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid #d1d5db;color:#4b5563">${inner()}</blockquote>`;
    case "codeBlock": return `<pre style="margin:0 0 16px;padding:12px;background:#f3f4f6;white-space:pre-wrap;font-family:monospace">${escapeHtml(children(node).map((child) => (typeof child.text === "string" ? child.text : "")).join(""))}</pre>`;
    case "horizontalRule": return `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">`;
    default: return "";
  }
}

function inlineText(node: RichNode): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type !== "text" || typeof node.text !== "string") return "";
  const href = (Array.isArray(node.marks) ? node.marks : []).find((mark) => mark?.type === "link");
  const url = href ? safeHref(href.attrs?.href) : null;
  // A link's address after its words, as plain-text mail can't hide it.
  return url && url !== node.text ? `${node.text} (${url})` : node.text;
}

function blockText(node: RichNode, depth: number, prefix = ""): string[] {
  if (depth > MAX_DEPTH) return [];
  const line = () => children(node).map(inlineText).join("");
  switch (node.type) {
    case "doc":
    case "blockquote": {
      const parts = children(node).flatMap((child) => blockText(child, depth + 1));
      return node.type === "blockquote" ? parts.map((part) => part.split("\n").map((row) => `> ${row}`).join("\n")) : parts;
    }
    case "paragraph": return [line()].filter((text) => text.trim());
    case "heading": return [line().toUpperCase()].filter((text) => text.trim());
    case "codeBlock": return [children(node).map((child) => child.text ?? "").join("")].filter((text) => text.trim());
    case "horizontalRule": return ["———"];
    case "bulletList":
    case "orderedList": {
      const items = children(node).filter((child) => child.type === "listItem");
      return [items.map((item, index) => {
        const marker = node.type === "orderedList" ? `${index + 1}. ` : "- ";
        const body = children(item).flatMap((child) => (child.type === "bulletList" || child.type === "orderedList" ? blockText(child, depth + 2, `${prefix}  `) : blockText(child, depth + 2))).join("\n");
        return `${prefix}${marker}${body}`;
      }).join("\n")].filter(Boolean);
    }
    default: return [];
  }
}

/** The document as email HTML and as plain text, with a blank line between blocks. */
export function richTextEmail(doc: RichNode): { html: string; text: string } {
  return { html: blockHtml(doc, 0), text: blockText(doc, 0).join("\n\n").trim() };
}
