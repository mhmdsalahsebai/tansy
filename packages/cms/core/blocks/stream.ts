import { isDeepStrictEqual } from "node:util";
import { getFieldDefinition, isKnownFieldType, normalizedValue, refsProblem, valueRefs, type Issue } from "../fields/registry";
import { isEmpty, type FieldLike } from "../fields/validate";
import { MAX_BLOCK_DEPTH, type Block } from "./limits";

export { MAX_BLOCK_DEPTH, type Block };

export interface BlockDefinition {
  name: string;
  version: number;
  fields: FieldLike[];
}

export type BlockCatalog = Map<string, BlockDefinition>;

const STREAM = "stream";

const hasMissingField = (definition: BlockDefinition) => definition.fields.some((field) => !isKnownFieldType(field.type));

/** Null when the type is gone, the block predates its current definition, or a plugin behind one of its fields was removed. */
function definitionOf(block: Block, catalog: BlockCatalog) {
  const definition = catalog.get(block.type);
  return definition?.version === block.v && !hasMissingField(definition) ? definition : null;
}

const fieldValue = (block: Block, name: string) => (Object.hasOwn(block.value, name) ? block.value[name] : undefined);

/** Visits every block the current schema can read. A block it can't read is visited once and not entered. */
function walk(blocks: Block[], catalog: BlockCatalog, visit: (block: Block, definition: BlockDefinition | null) => void) {
  for (const block of blocks) {
    const definition = definitionOf(block, catalog);
    visit(block, definition);
    for (const field of definition?.fields ?? []) {
      const nested = field.type === STREAM ? fieldValue(block, field.name) : undefined;
      if (Array.isArray(nested)) walk(nested as Block[], catalog, visit);
    }
  }
}

interface Check {
  catalog: BlockCatalog;
  previous: Map<string, Block>;
  seen: Set<string>;
  issues: Issue[];
}

function checkValue(block: Block, definition: BlockDefinition, path: string, depth: number, check: Check) {
  const names = new Set(definition.fields.map((field) => field.name));
  for (const key of Object.keys(block.value)) {
    if (!names.has(key)) check.issues.push({ path: `${path}.${key}`, message: "This block has no such field." });
  }
  for (const field of definition.fields) {
    const config = (field.config ?? {}) as Record<string, unknown>;
    const at = `${path}.${field.name}`;
    const value = fieldValue(block, field.name);
    if (isEmpty(value)) {
      if (config.required) check.issues.push({ path: at, message: "This field is required." });
      continue;
    }
    const result = getFieldDefinition(field.type).value(config).safeParse(value);
    if (!result.success) {
      check.issues.push(...result.error.issues.map((issue) => ({ path: [at, ...issue.path].join("."), message: issue.message })));
      continue;
    }
    const problem = refsProblem(field, value);
    if (problem) check.issues.push({ path: at, message: problem });
    if (field.type === STREAM) checkBlocks(value as Block[], at, depth + 1, check);
  }
}

/** Runs each field's `normalize` at every depth, on a copy. A block the schema can't read stays as it is, so it still matches what's stored. */
export function normalizeBlocks(blocks: Block[], catalog: BlockCatalog, depth = 1): Block[] {
  if (depth > MAX_BLOCK_DEPTH) return blocks;
  return blocks.map((block) => {
    const definition = definitionOf(block, catalog);
    if (!definition) return block;
    const value = { ...block.value };
    for (const field of definition.fields) {
      const current = fieldValue(block, field.name);
      if (isEmpty(current)) continue;
      value[field.name] = field.type === STREAM && Array.isArray(current) ? normalizeBlocks(current as Block[], catalog, depth + 1) : normalizedValue(field, current);
    }
    return { ...block, value };
  });
}

function checkBlocks(blocks: Block[], path: string, depth: number, check: Check) {
  if (depth > MAX_BLOCK_DEPTH && blocks.length) {
    check.issues.push({ path, message: `Blocks can nest at most ${MAX_BLOCK_DEPTH} levels deep.` });
    return;
  }
  blocks.forEach((block, index) => {
    const at = `${path}.${index}`;
    if (check.seen.has(block.id)) check.issues.push({ path: `${at}.id`, message: "Another block already uses this id." });
    check.seen.add(block.id);

    const definition = definitionOf(block, check.catalog);
    if (definition) checkValue(block, definition, `${at}.value`, depth, check);
    // Only a block already stored here can skip validation, so this can't be used to save unchecked values.
    else if (!isDeepStrictEqual(block, check.previous.get(block.id))) {
      const known = check.catalog.get(block.type);
      const message = !known ? "This block type does not exist." : hasMissingField(known) ? "A plugin this block needs is not installed." : "This block is out of date. Update it to the current version.";
      check.issues.push({ path: `${at}.type`, message });
    }
  });
}

/** Problems with a stream's blocks at any depth. The caller has already checked the top-level list. */
export function streamIssues(fieldName: string, blocks: Block[], stored: unknown, catalog: BlockCatalog): Issue[] {
  const previous = new Map<string, Block>();
  if (Array.isArray(stored)) walk(stored as Block[], catalog, (block) => previous.set(block.id, block));
  const check: Check = { catalog, previous, seen: new Set(), issues: [] };
  checkBlocks(blocks, fieldName, 1, check);
  return check.issues;
}

function collectBlockIds(node: unknown, into: Set<string>) {
  if (!node || typeof node !== "object") return;
  const { id, type } = node as Partial<Block>;
  if (typeof id === "string" && typeof type === "string") into.add(id);
  Object.values(node).forEach((child) => collectBlockIds(child, into));
}

export interface BlockLink {
  blockId: string;
  field: string;
  multiple: boolean;
  targetCollectionId: number;
  targetRecordIds: number[];
}

/** Replaces every value of one field type at any depth, on a copy. A block the schema can't read isn't entered. */
export function mapFieldValues(blocks: Block[], catalog: BlockCatalog, type: string, change: (field: FieldLike, value: unknown) => unknown): Block[] {
  return blocks.map((block) => {
    const definition = definitionOf(block, catalog);
    if (!definition) return block;
    const value = { ...block.value };
    for (const field of definition.fields) {
      const current = fieldValue(block, field.name);
      if (isEmpty(current)) continue;
      if (field.type === type) value[field.name] = change(field, current);
      else if (field.type === STREAM && Array.isArray(current)) value[field.name] = mapFieldValues(current as Block[], catalog, type, change);
    }
    return { ...block, value };
  });
}

/** Turns a `refs` collection into its id. 0 matches no collection, so an unknown slug fails the existence check. */
export type CollectionResolver = (collection: number | string) => number;
const idsOnly: CollectionResolver = (collection) => (typeof collection === "number" ? collection : 0);

export function collectionResolver(collections: Array<{ id: number; slug: string }>): CollectionResolver {
  const bySlug = new Map(collections.map((collection) => [collection.slug, collection.id]));
  return (collection) => (typeof collection === "number" ? collection : (bySlug.get(collection) ?? 0));
}

/** Links a value declares through `refs`, one entry per target collection. */
export function declaredLinks(field: FieldLike, value: unknown, resolve: CollectionResolver) {
  const byTarget = new Map<number, number[]>();
  for (const { collection, id } of valueRefs(field, value).records) {
    const target = resolve(collection);
    byTarget.set(target, [...(byTarget.get(target) ?? []), id]);
  }
  return [...byTarget].map(([targetCollectionId, targetRecordIds]) => ({ targetCollectionId, targetRecordIds }));
}

function collectLinks(blocks: Block[], catalog: BlockCatalog, onOpaque: (block: Block) => void, resolve: CollectionResolver) {
  const links: BlockLink[] = [];
  walk(blocks, catalog, (block, definition) => {
    if (!definition) return onOpaque(block);
    for (const field of definition.fields) {
      const { references, sql } = getFieldDefinition(field.type).storage((field.config ?? {}) as Record<string, unknown>);
      const value = fieldValue(block, field.name);
      if (references) {
        const targetRecordIds = [value].flat().filter((id): id is number => typeof id === "number");
        if (targetRecordIds.length) links.push({ blockId: block.id, field: field.name, multiple: sql === "json", targetCollectionId: references, targetRecordIds });
      }
      for (const link of declaredLinks(field, value, resolve)) links.push({ blockId: block.id, field: field.name, multiple: true, ...link });
    }
  });
  return links;
}

/** Each link field in a stream the current schema can read, for expansion. */
export const streamLinks = (blocks: Block[], catalog: BlockCatalog, resolve: CollectionResolver = idsOnly) => collectLinks(blocks, catalog, () => {}, resolve);

export interface BlockRef {
  blockId: string;
  targetCollectionId: number;
  targetRecordId: number;
}

/** The links in a stream, and the ids of blocks whose existing links must be left alone. */
export function streamRefs(blocks: Block[], catalog: BlockCatalog, resolve: CollectionResolver = idsOnly) {
  const opaque = new Set<string>();
  const links = collectLinks(blocks, catalog, (block) => collectBlockIds(block, opaque), resolve);
  const refs: BlockRef[] = links.flatMap(({ blockId, targetCollectionId, targetRecordIds }) => targetRecordIds.map((targetRecordId) => ({ blockId, targetCollectionId, targetRecordId })));
  return { refs, opaque };
}

export interface BlockFiles {
  blockId: string;
  field: FieldLike;
  fileIds: string[];
}

/** The files used in a stream, and the ids of blocks whose existing file links must be left alone. */
export function streamFiles(blocks: Block[], catalog: BlockCatalog) {
  const opaque = new Set<string>();
  const files: BlockFiles[] = [];
  walk(blocks, catalog, (block, definition) => {
    if (!definition) return collectBlockIds(block, opaque);
    for (const field of definition.fields) {
      const value = fieldValue(block, field.name);
      const stored = getFieldDefinition(field.type).storage((field.config ?? {}) as Record<string, unknown>).files ? [value].flat().filter((id): id is string => typeof id === "string" && id !== "") : [];
      const fileIds = [...stored, ...valueRefs(field, value).files];
      if (fileIds.length) files.push({ blockId: block.id, field, fileIds });
    }
  });
  return { files, opaque };
}

type BlockValue = Record<string, unknown>;
export type BlockUpgrades = Record<string, Record<number, (value: BlockValue) => BlockValue>>;

/** A failing or missing step leaves the block as stored, so a bad upgrade can't lose content or break a read. */
function upgradeBlock(block: Block, catalog: BlockCatalog, upgrades: BlockUpgrades): Block {
  const definition = catalog.get(block.type);
  const steps = Object.hasOwn(upgrades, block.type) ? upgrades[block.type] : undefined;
  if (!definition || !steps || block.v >= definition.version) return block;
  let value = block.value;
  try {
    for (let version = block.v; version < definition.version; version++) {
      if (!Object.hasOwn(steps, version)) return block;
      value = steps[version](value);
    }
  } catch {
    return block;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? { ...block, v: definition.version, value } : block;
}

export function upgradeBlocks(blocks: Block[], catalog: BlockCatalog, upgrades: BlockUpgrades): Block[] {
  return blocks.map((stored) => {
    const block = upgradeBlock(stored, catalog, upgrades);
    const definition = definitionOf(block, catalog);
    if (!definition) return block;
    const value = { ...block.value };
    for (const field of definition.fields) {
      const nested = field.type === STREAM ? fieldValue(block, field.name) : undefined;
      if (Array.isArray(nested)) value[field.name] = upgradeBlocks(nested as Block[], catalog, upgrades);
    }
    return { ...block, value };
  });
}
