import type { Block } from "../../core/blocks/limits";
import type { EditorInput } from "../../core/fields/define";
import type { BlockTypeInfo, EditorCatalog } from "../fields/types";

/** What a stream field's config can limit. */
export interface StreamConfig {
  allowedBlocks?: string[];
  min?: number;
  max?: number;
  blockLimits?: Record<string, number>;
  /** Editor only: the blocks and their order are fixed, as in a translation of a synced stream. Only their contents change. */
  fixed?: boolean;
}

export const isBlock = (value: unknown): value is Block => {
  const block = value as Partial<Block> | null;
  return typeof block?.id === "string" && typeof block.type === "string" && typeof block.v === "number" && typeof block.value === "object" && block.value !== null;
};

export const isBlockList = (value: unknown): value is Block[] => Array.isArray(value) && value.length > 0 && value.every(isBlock);

/** Block ids must be unique within a record, so a copy, a duplicate or a reused layout gets new ones at every depth. */
export function withFreshIds(blocks: Block[]): Block[] {
  return blocks.map((block) => ({
    ...block,
    id: crypto.randomUUID(),
    value: Object.fromEntries(Object.entries(block.value).map(([name, value]) => [name, isBlockList(value) ? withFreshIds(value) : value])),
  }));
}

export const newBlock = (type: BlockTypeInfo, value: Record<string, unknown> = {}): Block => ({ id: crypto.randomUUID(), type: type.name, v: type.version, value: { ...type.defaults, ...value } });

export const insertAt = (blocks: Block[], index: number, added: Block[]) => [...blocks.slice(0, index), ...added, ...blocks.slice(index)];

export const removeAt = (blocks: Block[], index: number) => blocks.filter((_, at) => at !== index);

export function moveTo(blocks: Block[], from: number, to: number) {
  if (to < 0 || to >= blocks.length || from === to) return blocks;
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export const duplicateAt = (blocks: Block[], index: number) => insertAt(blocks, index + 1, withFreshIds([blocks[index]]));

/** The block types this list can still take, given its allowed types, its size limit and each type's limit. */
export function addableTypes(blocks: Block[], config: StreamConfig, catalog: EditorCatalog, extra = 0): BlockTypeInfo[] {
  if (config.max !== undefined && blocks.length + extra >= config.max) return [];
  return catalog.blockTypes.filter(({ name }) => {
    if (config.allowedBlocks && !config.allowedBlocks.includes(name)) return false;
    const limit = config.blockLimits && Object.hasOwn(config.blockLimits, name) ? config.blockLimits[name] : Infinity;
    return blocks.filter((block) => block.type === name).length < limit;
  });
}

/** Whether a set of blocks, such as a duplicate or a layout, can go into this list as it stands. */
export function canAdd(blocks: Block[], added: Block[], config: StreamConfig) {
  if (config.max !== undefined && blocks.length + added.length > config.max) return false;
  return added.every((block) => {
    if (config.allowedBlocks && !config.allowedBlocks.includes(block.type)) return false;
    const limit = config.blockLimits && Object.hasOwn(config.blockLimits, block.type) ? config.blockLimits[block.type] : Infinity;
    return [...blocks, ...added].filter((item) => item.type === block.type).length <= limit;
  });
}

const inputOf = (catalog: EditorCatalog, type: string): EditorInput => catalog.fieldTypes.find((info) => info.type === type)?.input ?? "unavailable";

const SETTINGS: ReadonlySet<EditorInput> = new Set(["boolean", "select", "multiselect", "number", "date", "datetime", "email", "url", "reference"]);

/**
 * Where a field is edited. Content goes on the canvas, where it reads as it will
 * look, and settings go in the sidebar. A record's single images and files are
 * settings too, as a featured image is, while a block's are its content.
 */
export function placement(input: EditorInput, config: Record<string, unknown> | null | undefined, where: "block" | "record"): "canvas" | "settings" {
  if (SETTINGS.has(input)) return "settings";
  if (where === "record" && (input === "image" || input === "file" || (input === "text" && !config?.multiline))) return "settings";
  return "canvas";
}

export const blockPlacement = (catalog: EditorCatalog, field: { type: string; config?: unknown }) =>
  placement(inputOf(catalog, field.type), field.config as Record<string, unknown> | undefined, "block");

/**
 * The block that plain typing starts, as a paragraph does in most editors: an
 * addable type whose only content is one rich text field, with the fewest
 * settings. A lone multi-line text field will do when there's no rich text.
 */
export function defaultBlockType(types: BlockTypeInfo[], catalog: EditorCatalog) {
  const candidates = (accepts: (field: BlockTypeInfo["fields"][number]) => boolean) => types
    .filter((type) => {
      const content = type.fields.filter((field) => blockPlacement(catalog, field) === "canvas");
      return content.length === 1 && accepts(content[0]);
    })
    .sort((a, b) => a.fields.length - b.fields.length);
  return candidates((field) => inputOf(catalog, field.type) === "richtext")[0]
    ?? candidates((field) => inputOf(catalog, field.type) === "text" && Boolean((field.config as { multiline?: boolean } | undefined)?.multiline))[0];
}

/** The value that puts typed text into a block's one content field. */
export function typedValue(type: BlockTypeInfo, catalog: EditorCatalog, text: string): Record<string, unknown> {
  const field = type.fields.find((item) => blockPlacement(catalog, item) === "canvas");
  if (!field) return {};
  if (inputOf(catalog, field.type) === "richtext") return { [field.name]: { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] } };
  return { [field.name]: text };
}

/** A short line naming a block's content, for the outline and for blocks with nothing to show on the canvas. */
export function blockSummary(block: Block, max = 60): string {
  for (const value of Object.values(block.value)) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, max);
    const text = richText(value).trim();
    if (text) return text.slice(0, max);
  }
  return "";
}

function richText(node: unknown): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const { text, content } = node as { text?: unknown; content?: unknown };
  if (typeof text === "string") return text;
  return Array.isArray(content) ? content.map(richText).join(" ") : "";
}

/** Matches a search against a block type's label, name and category. */
export function matchesQuery(type: BlockTypeInfo, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${type.label} ${Object.values(type.labels ?? {}).join(" ")} ${type.name} ${type.category ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
