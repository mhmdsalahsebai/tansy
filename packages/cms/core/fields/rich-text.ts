/** TipTap's document format, shared by server validation, the editor and the renderer. No server or browser imports. */
export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: RichNode[];
  content?: RichNode[];
}

const STRUCTURE = new Set(["doc", "paragraph", "text", "hardBreak", "listItem"]);
export const RICH_NODES = ["heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule"] as const;
export const RICH_MARKS = ["bold", "italic", "strike", "underline", "code", "link"] as const;

const NODES = new Set<string>([...STRUCTURE, ...RICH_NODES]);
const MARKS = new Set<string>(RICH_MARKS);
const MAX_DEPTH = 32;
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** The text in a document, for search. */
export function richTextWords(node: unknown, depth = 0): string[] {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return [];
  const { text, content } = node as { text?: unknown; content?: unknown };
  return [...(typeof text === "string" ? [text] : []), ...(Array.isArray(content) ? content.flatMap((child) => richTextWords(child, depth + 1)) : [])];
}

/** The normalized link, or null if it isn't safe to put in an href. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href);
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** `allowedFeatures` as a set, or undefined when every feature is allowed. */
export function featureSet(features: string[] | Record<string, boolean> | undefined) {
  if (!features) return undefined;
  return new Set(Array.isArray(features) ? features : Object.keys(features).filter((key) => features[key]));
}

function nodeProblem(node: unknown, allowed: Set<string> | undefined, depth: number): string | null {
  if (depth > MAX_DEPTH) return "Rich text is nested too deeply.";
  if (!node || typeof node !== "object" || Array.isArray(node)) return "Rich text contains an invalid node.";
  const { type, text, attrs, marks, content } = node as RichNode;
  if (typeof type !== "string" || !NODES.has(type)) return "Rich text contains an unsupported element.";
  if (allowed && !STRUCTURE.has(type) && !allowed.has(type)) return `Rich text does not allow "${type}" here.`;
  if (text !== undefined && typeof text !== "string") return "Rich text contains an invalid node.";
  if (type === "heading" && ![1, 2, 3, 4, 5, 6].includes(attrs?.level as number)) return "Heading level must be 1 to 6.";

  if (marks !== undefined) {
    if (!Array.isArray(marks)) return "Rich text contains an invalid mark.";
    for (const mark of marks) {
      if (!mark || typeof mark.type !== "string" || !MARKS.has(mark.type)) return "Rich text contains an unsupported style.";
      if (allowed && !allowed.has(mark.type)) return `Rich text does not allow "${mark.type}" here.`;
      if (mark.type === "link" && safeHref(mark.attrs?.href) === null) return "Links must use http, https or mailto.";
    }
  }
  if (content === undefined) return null;
  if (!Array.isArray(content)) return "Rich text contains an invalid node.";
  for (const child of content) {
    const problem = nodeProblem(child, allowed, depth + 1);
    if (problem) return problem;
  }
  return null;
}

/** Why a value can't be stored as rich text. Only the root is required to be a doc; TipTap enforces the finer nesting. */
export function richTextProblem(doc: unknown, allowed?: Set<string>): string | null {
  if ((doc as RichNode | null)?.type !== "doc") return "Rich text must be a document.";
  return nodeProblem(doc, allowed, 0);
}

export const isRichDoc = (value: unknown): value is RichNode => Boolean(value) && typeof value === "object" && (value as RichNode).type === "doc";

export function plainText(node: RichNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainText).join(node.type === "doc" ? " " : "");
}
