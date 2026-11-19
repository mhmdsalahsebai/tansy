import "server-only";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "../../generated/client-sqlite";
import { getCmsConfig } from "../config";
import { referencedCollection, resolveFieldConfig, type Issue } from "../fields/registry";
import { validateValues, type FieldLike } from "../fields/validate";
import { HttpError, notFound } from "../http/errors";
import { fieldNameProblem } from "../schema/names";
import prisma from "../../lib/prisma";
import { cleanLabels, type Labels } from "../i18n/labels";
import { normalizeBlocks, streamIssues, upgradeBlocks, type Block, type BlockCatalog, type BlockUpgrades } from "./stream";

export interface RequestedBlockField {
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

/** These need a column or per-record handling, so inside a block they would look enforced without being so. */
const UNSUPPORTED_OPTIONS = ["unique", "hidden", "readonly", "defaultValue"];

const invalid = (issues: Issue[]) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", issues);

async function resolveFields(blockName: string, requested: RequestedBlockField[]) {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const fields: Array<FieldLike & { config: Record<string, unknown> }> = [];
  const collections: Array<{ path: string; id: number }> = [];
  const blocks: Array<{ path: string; name: string }> = [];

  requested.forEach((field, index) => {
    const at = `fields.${index}`;
    const nameProblem = fieldNameProblem(field.name);
    if (nameProblem) issues.push({ path: `${at}.name`, message: nameProblem });
    if (seen.has(field.name.toLowerCase())) issues.push({ path: `${at}.name`, message: "Another field already uses this name." });
    seen.add(field.name.toLowerCase());

    const resolved = resolveFieldConfig(field.type, field.config);
    if (!resolved.ok) {
      issues.push(...resolved.issues.map((issue) => ({ path: `${at}.${issue.path}`, message: issue.message })));
      return;
    }
    for (const option of UNSUPPORTED_OPTIONS) {
      const value = resolved.config[option];
      if (value !== undefined && value !== false) issues.push({ path: `${at}.config.${option}`, message: "Block fields do not support this option." });
    }
    const target = referencedCollection(field.type, resolved.config);
    if (target) collections.push({ path: `${at}.config.collection`, id: target });
    for (const name of (resolved.config.allowedBlocks ?? []) as string[]) {
      if (name !== blockName) blocks.push({ path: `${at}.config.allowedBlocks`, name });
    }
    fields.push({ name: field.name, type: field.type, config: resolved.config });
  });

  const [foundCollections, foundBlocks] = await Promise.all([
    prisma.collection.findMany({ where: { id: { in: collections.map((c) => c.id) } }, select: { id: true } }),
    prisma.blockType.findMany({ where: { name: { in: blocks.map((b) => b.name) } }, select: { name: true } }),
  ]);
  const collectionIds = new Set(foundCollections.map((c) => c.id));
  const blockNames = new Set(foundBlocks.map((b) => b.name));
  for (const { path, id } of collections) if (!collectionIds.has(id)) issues.push({ path, message: "That collection does not exist." });
  for (const { path, name } of blocks) if (!blockNames.has(name)) issues.push({ path, message: `Block "${name}" does not exist.` });

  if (issues.length) throw invalid(issues);
  return fields;
}

/** Marks a block the CMS itself provides, which follows this code as a plugin's follows its manifest. */
const CORE_BLOCKS = "tansy";
const configuredPlugins = () => new Set([CORE_BLOCKS, ...(getCmsConfig().plugins ?? []).map((plugin) => plugin.name)]);

/** The plugin in charge of a block. If that plugin has been removed, the block is an ordinary one again. */
export const managedBy = (block: { source: string | null }) => (block.source && configuredPlugins().has(block.source) ? block.source : null);

export const managedBlockNames = async () => new Set((await prisma.blockType.findMany({ where: { source: { not: null } }, select: { name: true, source: true } })).filter(managedBy).map((block) => block.name));

function assertEditable(block: { source: string | null }) {
  const plugin = managedBy(block);
  if (plugin) throw new HttpError(409, "CONFLICT", `This block is defined by the ${plugin} plugin, so it can only be changed in code.`);
}

const pluginBlocks = () => (getCmsConfig().plugins ?? []).flatMap((plugin) => plugin.blocks ?? []);

/** Display details live with the plugin's code, so a plugin that's removed takes them with it and leaves stored blocks alone. */
export const listBlockTypes = async () => (await prisma.blockType.findMany({ orderBy: { name: "asc" } })).map((block) => {
  const code = managedBy(block) ? pluginBlocks().find((item) => item.name === block.name) : undefined;
  return { ...block, managedBy: managedBy(block), category: code?.category, previewImage: code?.previewImage, defaults: code?.defaults };
});

export async function requireBlockType(id: number) {
  const blockType = await prisma.blockType.findUnique({ where: { id } });
  if (!blockType) throw notFound("Block type");
  return blockType;
}

export async function createBlockType(input: { name: string; label: string; labels?: Labels | null; icon?: string; fields: RequestedBlockField[] }, createdById: string | null, source: string | null = null) {
  const fields = await resolveFields(input.name, input.fields);
  try {
    return await prisma.blockType.create({ data: { name: input.name, label: input.label, labels: cleanLabels(input.labels) ?? Prisma.DbNull, icon: input.icon, fields: fields as unknown as Prisma.InputJsonValue, source, createdById } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new HttpError(409, "CONFLICT", "That block name is already in use.");
    throw error;
  }
}

/** `labels` is left as it is when absent. */
type BlockChanges = { label: string; labels?: Labels | null; icon?: string; fields: RequestedBlockField[] };

/** Config that only words a field for people, which stored values don't depend on. */
const WORDING = new Set(["label", "labels", "description", "descriptions", "placeholder", "hint"]);

/** The fields without their wording, as stored values see them. */
function valueShape(fields: unknown): unknown {
  if (!Array.isArray(fields)) return fields;
  return fields.map((field: { config?: Record<string, unknown> } & Record<string, unknown>) => {
    const config = Object.fromEntries(Object.entries(field?.config ?? {}).filter(([key]) => !WORDING.has(key)).map(([key, value]) => [
      key,
      key === "options" && Array.isArray(value) ? value.map((option: Record<string, unknown>) => Object.fromEntries(Object.entries(option ?? {}).filter(([name]) => !WORDING.has(name)))) : value,
    ]));
    return { ...field, config };
  });
}

/**
 * The name can't change, because stored blocks refer to it. Changing the fields starts a
 * new version, which stored blocks must be upgraded to. Rewording them doesn't: a label in
 * another language would otherwise put every stored block of the type out of date.
 */
async function writeBlockType(current: Awaited<ReturnType<typeof requireBlockType>>, input: BlockChanges, source: string | null) {
  const fields = await resolveFields(current.name, input.fields);
  const version = isDeepStrictEqual(valueShape(current.fields), valueShape(fields)) ? current.version : current.version + 1;
  return prisma.blockType.update({ where: { id: current.id }, data: { label: input.label, ...(input.labels === undefined ? {} : { labels: cleanLabels(input.labels) ?? Prisma.DbNull }), icon: input.icon ?? null, fields: fields as unknown as Prisma.InputJsonValue, source, version } });
}

export async function updateBlockType(id: number, input: BlockChanges) {
  const current = await requireBlockType(id);
  assertEditable(current);
  return writeBlockType(current, input, current.source);
}

/** Stored blocks of this type are kept, and show as unavailable until the type returns. */
export async function deleteBlockType(id: number) {
  const current = await requireBlockType(id);
  assertEditable(current);
  const { name } = current;
  await prisma.blockType.delete({ where: { id } });
  return name;
}

/** For a schema import into a new database, so stored blocks mean the same version there. */
export async function setBlockVersion(name: string, version: number) {
  await prisma.blockType.update({ where: { name }, data: { version } });
}

/** A block with no owner and no author came from an earlier version of its plugin, or from a schema file replayed at startup. */
export const pluginCanOwn = (existing: { source: string | null; createdById: string | null }, plugin: string) =>
  existing.source ? existing.source === plugin : existing.createdById === null;

/**
 * Plugin blocks are created at startup and follow their definition. A name
 * someone else owns stops startup. A block that can't be saved is only logged,
 * so one bad block doesn't stop the server.
 */
export async function syncPluginBlocks(blocks: Array<{ name: string; label: string; labels?: Labels; icon?: string; fields: RequestedBlockField[]; source: string }>) {
  for (const block of blocks) {
    const existing = await prisma.blockType.findUnique({ where: { name: block.name } });
    if (existing && !pluginCanOwn(existing, block.source)) {
      throw new Error(`Plugin "${block.source}" defines block "${block.name}", but ${existing.source ? `plugin "${existing.source}"` : "a block made in the dashboard"} already uses that name. Rename one of them.`);
    }
    try {
      // The labels follow the plugin's code too, so dropping one there drops it here.
      if (!existing) await createBlockType(block, null, block.source);
      else await writeBlockType(existing, { ...block, labels: block.labels ?? null }, block.source);
    } catch (error) {
      console.error(`[plugins] could not save block "${block.name}"`, error);
    }
  }
}

/** One entry in a menu. It nests through its own `children`, within the stream depth limit. Links may be site paths, so the pattern is checked again when rendered. */
const MENU_ITEM = {
  name: "menu_item",
  label: "Menu item",
  labels: { ar: "عنصر قائمة" },
  fields: [
    { name: "label", type: "text", config: { required: true, maxLength: 120 } },
    { name: "url", type: "text", config: { required: true, maxLength: 2048, pattern: "^(/$|/[^/\\\\]|https?://.|mailto:.)", patternError: 'Use a site path such as "/about", or an http, https or mailto link.' } },
    { name: "newTab", type: "boolean", config: { label: "Open in a new tab" } },
    { name: "children", type: "stream", config: { allowedBlocks: ["menu_item"] } },
  ],
  source: CORE_BLOCKS,
};

/** A block someone already made under this name is theirs, so it's left alone, and only menus built on the real one are affected. */
export async function syncCoreBlocks() {
  const existing = await prisma.blockType.findUnique({ where: { name: MENU_ITEM.name } });
  if (existing && existing.source !== CORE_BLOCKS) {
    console.warn(`[blocks] "${MENU_ITEM.name}" already exists and isn't the built-in one, so <Menu> may not understand it.`);
    return;
  }
  try {
    // Created empty first, since it allows itself and that block must exist.
    const stored = existing ?? await createBlockType({ name: MENU_ITEM.name, label: MENU_ITEM.label, fields: [] }, null, CORE_BLOCKS);
    await writeBlockType(stored, MENU_ITEM, CORE_BLOCKS);
  } catch (error) {
    console.error(`[blocks] could not save "${MENU_ITEM.name}"`, error);
  }
}

export async function loadBlockCatalog(): Promise<BlockCatalog> {
  const rows = await prisma.blockType.findMany({ select: { name: true, version: true, fields: true } });
  return new Map(rows.map((row) => [row.name, { name: row.name, version: row.version, fields: row.fields as unknown as FieldLike[] }]));
}

/** validateValues, plus the block definitions behind any stream fields. */
export async function validateRecordValues(fields: FieldLike[], values: Record<string, unknown>, existing?: Record<string, unknown>) {
  const clean = validateValues(fields, values, existing);
  const streams = fields.filter((field) => field.type === "stream" && Array.isArray(clean[field.name]));
  if (!streams.length) return clean;
  const catalog = await loadBlockCatalog();
  for (const { name } of streams) clean[name] = normalizeBlocks(clean[name] as Block[], catalog);
  const issues = streams.flatMap((field) => streamIssues(field.name, clean[field.name] as Block[], existing?.[field.name], catalog));
  if (issues.length) throw invalid(issues);
  return clean;
}

/** Steps from tansy.config.ts, for blocks made in the dashboard, and from each plugin's own blocks. */
function allBlockUpgrades(): BlockUpgrades | undefined {
  const fromPlugins = pluginBlocks().flatMap((block) => (block.upgrades ? [[block.name, block.upgrades] as const] : []));
  const { blockUpgrades } = getCmsConfig();
  return blockUpgrades || fromPlugins.length ? { ...blockUpgrades, ...Object.fromEntries(fromPlugins) } : undefined;
}

/** Brings stored blocks up to date with any registered upgrades. */
export async function upgradeRows<T extends Record<string, unknown>>(fields: FieldLike[], rows: T[]): Promise<T[]> {
  const upgrades = allBlockUpgrades();
  const streams = fields.filter((field) => field.type === "stream");
  if (!upgrades || !streams.length || !rows.length) return rows;
  const catalog = await loadBlockCatalog();
  return rows.map((row) => {
    const next: Record<string, unknown> = { ...row };
    for (const { name } of streams) if (Array.isArray(row[name])) next[name] = upgradeBlocks(row[name] as Block[], catalog, upgrades);
    return next as T;
  });
}
