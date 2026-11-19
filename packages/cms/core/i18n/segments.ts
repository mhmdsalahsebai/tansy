/**
 * The translatable text in a record, as segments with stable ids, and the way back.
 * Machine translators and XLIFF both use it, so a value is taken apart and put back
 * the same way whoever translates it. No server or browser imports.
 */

export interface Segment {
  /** Field name, then block ids and inner fields, then a rich text node path: "body/9f2c/caption#0.1". */
  id: string;
  text: string;
}

/**
 * Translates text between languages. A plugin provides one as `translator` on its
 * manifest, so core never names a vendor. It gets text only: no record ids, no hidden
 * fields, nothing the person asking couldn't read themselves.
 */
export interface Translator {
  /** Shown on the editor's button, such as "DeepL". */
  label: string;
  /** One string per segment, in the same order. */
  translate(segments: Segment[], options: { from: string; to: string; collection: string }): Promise<string[]>;
}

interface FieldLike { name: string; type: string; config?: unknown }
export type SegmentCatalog = ReadonlyMap<string, { fields: FieldLike[] }>;

interface RichNode { type?: string; text?: string; content?: RichNode[] }

export const MAX_SEGMENTS = 5000;
const MAX_DEPTH = 12;
const MAX_RICH_DEPTH = 32;

/** Plain text fields, rich text and the blocks of a stream. Codes, addresses, numbers and choices mean the same in every language. */
const TEXT_TYPES = new Set(["text", "rich_text"]);
export const isTranslatableType = (type: string) => TEXT_TYPES.has(type) || type === "stream";

function richSegments(node: RichNode, prefix: string, path: number[], out: Segment[], depth: number) {
  if (!node || typeof node !== "object" || depth > MAX_RICH_DEPTH) return;
  if (typeof node.text === "string" && node.text.trim()) out.push({ id: `${prefix}#${path.join(".")}`, text: node.text });
  if (Array.isArray(node.content)) node.content.forEach((child, index) => richSegments(child, prefix, [...path, index], out, depth + 1));
}

function fieldSegments(field: FieldLike, value: unknown, prefix: string, catalog: SegmentCatalog, out: Segment[], depth: number) {
  if (value === null || value === undefined || depth > MAX_DEPTH || out.length >= MAX_SEGMENTS) return;
  if (field.type === "text" && typeof value === "string" && value.trim()) out.push({ id: prefix, text: value });
  else if (field.type === "rich_text") richSegments(value as RichNode, prefix, [], out, 0);
  else if (field.type === "stream" && Array.isArray(value)) {
    for (const block of value as Array<{ id?: string; type?: string; value?: Record<string, unknown> }>) {
      if (typeof block?.id !== "string" || !block.value) continue;
      for (const inner of catalog.get(block.type ?? "")?.fields ?? []) fieldSegments(inner, block.value[inner.name], `${prefix}/${block.id}/${inner.name}`, catalog, out, depth + 1);
    }
  }
}

/** Every translatable piece of text in these fields' values, in order. */
export function extractSegments(fields: FieldLike[], values: Record<string, unknown>, catalog: SegmentCatalog): Segment[] {
  const out: Segment[] = [];
  for (const field of fields) if (isTranslatableType(field.type)) fieldSegments(field, values[field.name], field.name, catalog, out, 0);
  return out.slice(0, MAX_SEGMENTS);
}

function applyRich(node: RichNode, prefix: string, path: number[], translated: ReadonlyMap<string, string>, depth: number): RichNode {
  if (!node || typeof node !== "object" || depth > MAX_RICH_DEPTH) return node;
  const id = `${prefix}#${path.join(".")}`;
  const next: RichNode = { ...node };
  if (typeof node.text === "string" && translated.has(id)) next.text = translated.get(id)!;
  if (Array.isArray(node.content)) next.content = node.content.map((child, index) => applyRich(child, prefix, [...path, index], translated, depth + 1));
  return next;
}

function applyField(field: FieldLike, value: unknown, prefix: string, catalog: SegmentCatalog, translated: ReadonlyMap<string, string>, depth: number): unknown {
  if (value === null || value === undefined || depth > MAX_DEPTH) return value;
  if (field.type === "text") return typeof value === "string" && translated.has(prefix) ? translated.get(prefix) : value;
  if (field.type === "rich_text") return applyRich(value as RichNode, prefix, [], translated, 0);
  if (field.type === "stream" && Array.isArray(value)) {
    return (value as Array<{ id?: string; type?: string; value?: Record<string, unknown> }>).map((block) => {
      if (typeof block?.id !== "string" || !block.value) return block;
      const inner = catalog.get(block.type ?? "")?.fields ?? [];
      const values = { ...block.value };
      for (const child of inner) values[child.name] = applyField(child, block.value[child.name], `${prefix}/${block.id}/${child.name}`, catalog, translated, depth + 1);
      return { ...block, value: values };
    });
  }
  return value;
}

/**
 * The values with each translated segment put back. Segments that don't match anything
 * are ignored, so a stale translation can't add text where the source has none. Block
 * ids, order and every value that isn't text stay as they were.
 */
export function applySegments(fields: FieldLike[], values: Record<string, unknown>, catalog: SegmentCatalog, translated: ReadonlyMap<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!isTranslatableType(field.type) || !(field.name in values)) continue;
    out[field.name] = applyField(field, values[field.name], field.name, catalog, translated, 0);
  }
  return out;
}
