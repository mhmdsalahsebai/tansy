/**
 * Synced streams: a localized stream whose blocks and their order belong to the default
 * language, while every other language holds only its own wording of them. No server or
 * browser imports, so the editor can line a translation up the same way the server does.
 */
import { isTranslatableType, type SegmentCatalog } from "./segments";

interface StoredBlock { id: string; type: string; value: Record<string, unknown>; [key: string]: unknown }

const MAX_DEPTH = 12;
const isBlock = (block: unknown): block is StoredBlock =>
  typeof block === "object" && block !== null && typeof (block as StoredBlock).id === "string" && typeof (block as StoredBlock).type === "string" && typeof (block as StoredBlock).value === "object" && (block as StoredBlock).value !== null;

/** Whether a field is a stream that follows the default language's blocks. Only a localized stream can be. */
export const isSyncedStream = (field: { type: string; config?: unknown }) => {
  const config = (field.config ?? {}) as { localized?: unknown; synced?: unknown };
  return field.type === "stream" && config.localized === true && config.synced === true;
};

/**
 * A translation lined up with its source: the source's blocks, in its order, each with the
 * translation's text where the translation has the same block, and the source's text where it
 * doesn't, which is how a new block reaches every language untranslated. Text is text and rich
 * text fields, and the same inside nested streams. Everything else, such as images, links,
 * numbers and choices, comes from the source. Blocks only the translation has are dropped.
 */
export function alignStream(source: unknown, translation: unknown, catalog: SegmentCatalog, depth = 0): unknown {
  if (!Array.isArray(source)) return source ?? null;
  const own = new Map((Array.isArray(translation) ? translation : []).filter(isBlock).map((block) => [block.id, block]));
  return source.map((block) => {
    if (!isBlock(block)) return block;
    const mine = own.get(block.id);
    if (!mine || mine.type !== block.type || depth > MAX_DEPTH) return block;
    const value = { ...block.value };
    for (const field of catalog.get(block.type)?.fields ?? []) {
      if (!isTranslatableType(field.type) || !Object.hasOwn(mine.value, field.name)) continue;
      value[field.name] = field.type === "stream" ? alignStream(block.value[field.name], mine.value[field.name], catalog, depth + 1) : mine.value[field.name];
    }
    return { ...block, value };
  });
}
