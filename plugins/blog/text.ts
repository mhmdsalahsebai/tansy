/** Pure helpers, shared by the server half and the render module. No imports, so both can use them. */

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lowercase letters, digits and single hyphens, from any title. */
export function slugify(text: string): string {
  const slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return slug || "post";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The words in a rich text document, one string per top-level node. */
function richTextParagraphs(doc: unknown): string[] {
  const words = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    const { text, content } = node as { text?: unknown; content?: unknown };
    if (typeof text === "string") return text;
    if (!Array.isArray(content)) return "";
    // Text runs with different marks sit side by side, so only block nodes get a space between them.
    const inline = content.every((child) => typeof (child as { text?: unknown } | null)?.text === "string" || (child as { type?: unknown } | null)?.type === "hardBreak");
    return content.map((child) => ((child as { type?: unknown } | null)?.type === "hardBreak" ? " " : words(child))).join(inline ? "" : " ");
  };
  const content = (doc as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? content.map(words).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean) : [];
}

/** The prose in a post's blocks, in order. Code and embeds aren't prose. */
export function blockParagraphs(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { type?: unknown; value?: Record<string, unknown> }) => {
    const value = block?.value ?? {};
    switch (block?.type) {
      case "blog_text":
      case "blog_callout": return richTextParagraphs(value.body);
      case "blog_quote": return [str(value.text)].filter(Boolean);
      case "blog_image": return [str(value.caption)].filter(Boolean);
      default: return [];
    }
  });
}

export const WORDS_PER_MINUTE = 220;

export function readingMinutes(blocks: unknown): number {
  const words = blockParagraphs(blocks).join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** The first paragraph, cut at a word boundary. */
export function excerptOf(blocks: unknown, max = 160): string {
  const first = blockParagraphs(blocks)[0] ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

/** Only YouTube and Vimeo, as the plugin's frame-src lists only them. Anything else stays a link. */
export function embedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\./, "");
  const id = (value: string | null | undefined, pattern: RegExp) => (value && pattern.test(value) ? value : null);
  const youtube = /^[A-Za-z0-9_-]{6,20}$/;
  let video: string | null = null;
  if (host === "youtube.com" || host === "m.youtube.com") video = id(parsed.pathname === "/watch" ? parsed.searchParams.get("v") : parsed.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1], youtube);
  else if (host === "youtu.be") video = id(parsed.pathname.slice(1), youtube);
  if (video) return `https://www.youtube-nocookie.com/embed/${video}`;
  if (host === "vimeo.com") {
    const vimeo = id(parsed.pathname.slice(1), /^\d{1,12}$/);
    if (vimeo) return `https://player.vimeo.com/video/${vimeo}`;
  }
  return null;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

export interface FeedItem { title: string; url: string; summary: string; publishedAt: string; updatedAt: string }
export interface Feed { title: string; siteUrl: string; feedUrl: string; items: FeedItem[] }

const rfc822 = (iso: string) => new Date(iso).toUTCString();

export function rss({ title, siteUrl, feedUrl, items }: Feed): string {
  const entries = items.map((item) => `<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.url)}</link><guid isPermaLink="true">${escapeXml(item.url)}</guid><pubDate>${rfc822(item.publishedAt)}</pubDate>${item.summary ? `<description>${escapeXml(item.summary)}</description>` : ""}</item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escapeXml(title)}</title><link>${escapeXml(siteUrl)}</link><description>${escapeXml(title)}</description><atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>${entries.join("")}</channel></rss>\n`;
}

export function atom({ title, siteUrl, feedUrl, items }: Feed): string {
  const updated = items.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), items[0]?.updatedAt ?? new Date(0).toISOString());
  const entries = items.map((item) => `<entry><title>${escapeXml(item.title)}</title><link href="${escapeXml(item.url)}"/><id>${escapeXml(item.url)}</id><published>${escapeXml(item.publishedAt)}</published><updated>${escapeXml(item.updatedAt)}</updated>${item.summary ? `<summary>${escapeXml(item.summary)}</summary>` : ""}</entry>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>${escapeXml(title)}</title><link href="${escapeXml(siteUrl)}"/><link rel="self" href="${escapeXml(feedUrl)}"/><id>${escapeXml(feedUrl)}</id><updated>${escapeXml(updated)}</updated>${entries.join("")}</feed>\n`;
}

/** The levels a theme can give a part's heading. The page's own h1 is the theme's. */
export type HeadingLevel = 2 | 3 | 4 | 5 | 6;

/** The tag for a heading at `level`, kept between h2 and h6. */
export function headingTag(level: number = 2): `h${HeadingLevel}` {
  return `h${Math.min(6, Math.max(2, Math.round(Number.isFinite(level) ? level : 2))) as HeadingLevel}`;
}
