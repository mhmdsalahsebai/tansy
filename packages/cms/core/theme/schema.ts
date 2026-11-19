import type { SchemaDocument } from "../schema/portable";

/** What a theme's schema names, as the keys its state remembers. */
export const themeParts = (document: SchemaDocument) => [
  ...document.collections.flatMap((c) => [`collection:${c.slug}`, ...c.fields.map((f) => `field:${c.slug}.${f.name}`)]),
  ...document.blocks.map((b) => `block:${b.name}`),
];

/**
 * What a theme version adds: collections and blocks that don't exist, and fields missing from
 * a collection that does. Each is added once. The theme's state remembers everything its schema
 * has named, so what an owner deleted or renamed since stays as they left it, and nothing
 * existing is ever changed. A field goes onto the collection as it stands, with its current
 * details, rules and URL pattern.
 */
export function themeAdditions(document: SchemaDocument, current: SchemaDocument, seen: ReadonlySet<string>): SchemaDocument {
  const collections = document.collections.flatMap((wanted) => {
    const existing = current.collections.find((c) => c.slug === wanted.slug);
    if (!existing) return seen.has(`collection:${wanted.slug}`) ? [] : [wanted];
    if (existing.type === "view" || existing.type !== wanted.type) return [];
    const fields = wanted.fields.filter((f) => !seen.has(`field:${wanted.slug}.${f.name}`) && !existing.fields.some((e) => e.name === f.name));
    return fields.length ? [{ ...existing, fields: [...existing.fields, ...fields] }] : [];
  });
  const blocks = document.blocks.filter((b) => !seen.has(`block:${b.name}`) && !current.blocks.some((e) => e.name === b.name));
  return { version: document.version, collections, blocks };
}

