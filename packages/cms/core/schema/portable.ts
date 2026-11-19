import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { listUserFields, saveUserFields } from "../auth/user-fields";
import type { Permission } from "../authz/permissions";
import { createBlockType, managedBlockNames, managedBy, setBlockVersion, updateBlockType } from "../blocks/service";
import { updateRules } from "../content/collections";
import { referencedCollection } from "../fields/registry";
import type { CollectionShape, FieldLabels } from "../extend/define";
import { HttpError } from "../http/errors";
import prisma from "../../lib/prisma";
import { createCollectionSchema, createViewCollection, updateCollectionDetails, updateCollectionLocalization, updateCollectionScope, updateFieldSchema, updateViewCollection } from "./service";
import { localizationOf } from "../i18n/context";
import { createLocale, listLocales, localizationSettings, setDefaultLocale, updateLocale } from "../i18n/locales";
import { cleanLabels, type Labels } from "../i18n/labels";
import { labelsSchema } from "../i18n/labels-schema";

const field = z.object({ name: z.string().max(120), type: z.string().max(40), config: z.record(z.string(), z.unknown()).default({}) });
const rule = z.string().max(4096).nullable();
const rules = z.object({ listRule: rule, viewRule: rule, createRule: rule, updateRule: rule, deleteRule: rule });
const localization = z.object({ enabled: z.literal(true), fallback: z.enum(["chain", "none"]).default("chain"), fieldFallback: z.boolean().default(false) }).nullable().optional();
const language = z.object({ code: z.string().max(35), label: z.string().trim().min(1).max(100), fallback: z.string().max(35).nullable().default(null), direction: z.enum(["ltr", "rtl"]).default("ltr"), public: z.boolean().default(false) });

/** Schema without data, with links between collections written as slugs because ids differ on every database. */
export const schemaDocument = z.object({
  version: z.literal(1),
  collections: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
    name: z.string().max(120),
    /** The name in other interface languages. Left as it is when absent. */
    labels: labelsSchema(120).nullable().optional(),
    description: z.string().max(1000).nullable().default(null),
    type: z.enum(["base", "singleton", "view"]).default("base"),
    viewQuery: z.string().max(10_000).nullable().default(null),
    urlPattern: z.string().max(2048).nullable().default(null),
    /** Publishing needs `record:publish`. Left as it is when absent. */
    reviewRequired: z.boolean().optional(),
    /** Split by the scope provider's value (core/scope). */
    scoped: z.boolean().optional(),
    rules,
    /** Off when null, and left as it is when absent. Which fields hold a value per language is `localized` in each field's config. */
    localization,
    fields: z.array(field).max(500),
  })).max(1000),
  /** The languages content is written in. An import adds any that are missing and never removes one. */
  locales: z.array(language).max(200).optional(),
  defaultLocale: z.string().max(35).optional(),
  blocks: z.array(z.object({ name: z.string().max(63), label: z.string().max(120), labels: labelsSchema(200).nullable().optional(), icon: z.string().max(60).nullable().default(null), version: z.number().int().positive().default(1), fields: z.array(field).max(200) })).max(1000).default([]),
  /** Absent when whoever exported it may not read user field definitions. Then import leaves them alone. */
  userFields: z.array(field.extend({ selfEditable: z.boolean().default(false) })).max(100).optional(),
});

export type SchemaDocument = z.output<typeof schemaDocument>;
type DocCollection = SchemaDocument["collections"][number];
type Config = Record<string, unknown>;

function portableConfig(type: string, config: Config, slugs: Map<number, string>): Config {
  const target = referencedCollection(type, config);
  return target ? { ...config, collection: slugs.get(target) ?? null } : config;
}

function localConfig(config: Config, ids: Map<string, number>, where: string): Config {
  if (typeof config.collection !== "string") return config;
  const id = ids.get(config.collection);
  if (!id) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path: where, message: `Collection "${config.collection}" does not exist.` }]);
  return { ...config, collection: id };
}

/**
 * Adds the fields a collection doesn't have yet, matched by name, and changes nothing else:
 * not its other fields, rules, name or address, which its owner may have edited. A reference
 * names its collection by slug. Returns whether anything was added.
 */
export async function addCollectionFields(slug: string, fields: Array<{ name: string; type: string; config?: Config }>, actorId: string | null) {
  const current = await prisma.collection.findUnique({ where: { slug }, include: { fields: { orderBy: { id: "asc" } } } });
  if (!current) throw new Error(`There's no collection "${slug}".`);
  if (current.type === "view") throw new Error(`"${slug}" is a view, whose columns come from its query.`);
  const missing = fields.filter((field) => !current.fields.some((existing) => existing.name === field.name));
  if (!missing.length) return false;
  const ids = new Map((await prisma.collection.findMany({ select: { id: true, slug: true } })).map((c) => [c.slug, c.id]));
  const requested = [
    ...current.fields.map((field) => ({ id: field.id, name: field.name, type: field.type, config: (field.config ?? {}) as Config })),
    ...missing.map((field, index) => ({ name: field.name, type: field.type, config: localConfig(field.config ?? {}, ids, `fields.${index}`) })),
  ];
  await updateFieldSchema(current.id, requested, false, actorId);
  return true;
}

export async function addFieldOptions(slug: string, name: string, options: Array<{ label: string; value: string }>, actorId: string | null) {
  const current = await prisma.collection.findUnique({ where: { slug }, include: { fields: { orderBy: { id: "asc" } } } });
  if (!current) throw new Error(`There's no collection "${slug}".`);
  const field = current.fields.find((candidate) => candidate.name === name);
  // The owner may have removed it, and that's theirs to decide.
  if (!field) return false;
  const config = (field.config ?? {}) as Config;
  if (!Array.isArray(config.options)) throw new Error(`"${slug}.${name}" is a ${field.type} field, which has no choices.`);
  const existing = config.options as Array<{ value?: unknown }>;
  const missing = options.filter((option) => !existing.some((choice) => choice.value === option.value));
  if (!missing.length) return false;
  const requested = current.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, config: f.id === field.id ? { ...config, options: [...existing, ...missing] } : (f.config ?? {}) as Config }));
  await updateFieldSchema(current.id, requested, false, actorId);
  return true;
}

/** Adds names in languages the collection has none in. The owner's own stay. Returns whether anything was added. */
export async function addCollectionLabels(slug: string, labels: Labels, actorId: string | null) {
  const current = await prisma.collection.findUnique({ where: { slug }, select: { id: true, labels: true } });
  if (!current) return false;
  const stored = (current.labels ?? {}) as Labels;
  const missing = Object.entries(cleanLabels(labelsSchema(120).parse(labels)) ?? {}).filter(([code]) => !stored[code]);
  if (!missing.length) return false;
  await updateCollectionDetails(current.id, { labels: { ...stored, ...Object.fromEntries(missing) } }, actorId);
  return true;
}

/** The entries of `given` in languages `stored` has none in, over `stored`. Unchanged when there are none. */
function withMissing(stored: unknown, given: Labels | undefined, max: number): Labels | null {
  const current = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Labels;
  const missing = Object.entries(cleanLabels(labelsSchema(max).parse(given ?? {})) ?? {}).filter(([code]) => !current[code]);
  return missing.length ? { ...current, ...Object.fromEntries(missing) } : null;
}

/** Fields with `given`'s words added in languages they have none in, and whether any were. */
function withFieldWords<F extends { name: string; config?: unknown }>(fields: F[], given: Record<string, FieldLabels>): { fields: F[]; changed: boolean } {
  let changed = false;
  const result = fields.map((field) => {
    const config = (field.config ?? {}) as Config;
    const words = Object.hasOwn(given, field.name) ? given[field.name] : undefined;
    if (!words) return field;
    const next: Config = { ...config };
    const labels = withMissing(config.labels, words.labels, 200);
    if (labels) next.labels = labels;
    const descriptions = withMissing(config.descriptions, words.descriptions, 1000);
    if (descriptions) next.descriptions = descriptions;
    let optionsChanged = false;
    if (words.options && Array.isArray(config.options)) {
      const choices = words.options;
      next.options = (config.options as Array<Record<string, unknown>>).map((option) => {
        const value = typeof option.value === "string" ? option.value : "";
        const optionLabels = Object.hasOwn(choices, value) ? withMissing(option.labels, choices[value], 200) : null;
        if (!optionLabels) return option;
        optionsChanged = true;
        return { ...option, labels: optionLabels };
      });
    }
    if (!labels && !descriptions && !optionsChanged) return field;
    changed = true;
    return { ...field, config: next };
  });
  return { fields: result, changed };
}

/**
 * Adds field labels, descriptions and choice labels in languages a field has none in, by
 * field name and choice value. The owner's own words stay, and a field or choice the owner
 * removed is skipped. Returns whether anything was added.
 */
export async function addFieldLabels(slug: string, given: Record<string, FieldLabels>, actorId: string | null) {
  const current = await prisma.collection.findUnique({ where: { slug }, include: { fields: { orderBy: { id: "asc" } } } });
  if (!current) return false;
  const { fields, changed } = withFieldWords(current.fields.map((field) => ({ id: field.id, name: field.name, type: field.type, config: (field.config ?? {}) as Config })), given);
  if (!changed) return false;
  await updateFieldSchema(current.id, fields, false, actorId);
  return true;
}

/** The same for a block made in the dashboard or by a schema file. A block a plugin defines in code takes its words from that code. */
export async function addBlockFieldLabels(name: string, given: Record<string, FieldLabels>) {
  const current = await prisma.blockType.findUnique({ where: { name } });
  if (!current || managedBy(current)) return false;
  const { fields, changed } = withFieldWords(current.fields as unknown as Array<{ name: string; type: string; config?: Config }>, given);
  if (!changed) return false;
  await updateBlockType(current.id, { label: current.label, icon: current.icon ?? undefined, fields });
  return true;
}

export async function exportSchema({ userFields }: { userFields: boolean }): Promise<SchemaDocument> {
  const [collections, blocks] = await Promise.all([
    prisma.collection.findMany({ include: { fields: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } }),
    prisma.blockType.findMany({ orderBy: { id: "asc" } }),
  ]);
  const slugs = new Map(collections.map((c) => [c.id, c.slug]));
  return {
    version: 1,
    collections: collections.map((c) => ({
      slug: c.slug,
      name: c.name,
      labels: c.labels as Labels | null,
      description: c.description,
      type: c.type === "view" || c.type === "singleton" ? c.type : "base",
      viewQuery: c.viewQuery,
      urlPattern: c.urlPattern,
      ...(c.reviewRequired ? { reviewRequired: true } : {}),
      ...(c.scoped ? { scoped: true } : {}),
      rules: { listRule: c.listRule, viewRule: c.viewRule, createRule: c.createRule, updateRule: c.updateRule, deleteRule: c.deleteRule },
      localization: localizationOf(c) as z.output<typeof localization>,
      // A view's fields come from its query.
      fields: c.type === "view" ? [] : c.fields.map((f) => ({ name: f.name, type: f.type, config: portableConfig(f.type, (f.config ?? {}) as Config, slugs) })),
    })),
    blocks: blocks.map((b) => ({
      name: b.name,
      label: b.label,
      labels: b.labels as Labels | null,
      icon: b.icon,
      version: b.version,
      fields: (b.fields as Array<{ name: string; type: string; config?: Config }>).map((f) => ({ name: f.name, type: f.type, config: portableConfig(f.type, f.config ?? {}, slugs) })),
    })),
    ...(userFields ? { userFields: (await listUserFields()).map((f) => ({ name: f.name, type: f.type, config: f.config as Config, selfEditable: f.selfEditable })) } : {}),
    locales: (await listLocales()).map(({ code, label, fallback, direction, public: isPublic }) => ({ code, label, fallback, direction, public: isPublic })),
    defaultLocale: (await localizationSettings()).defaultLocale,
  };
}

/** One collection as exported, or null when there's no collection with that slug. Rules are left out: a plugin reads its shape, not who may reach it. */
export async function describeCollection(slug: string): Promise<CollectionShape | null> {
  const collection = await prisma.collection.findUnique({ where: { slug }, include: { fields: { orderBy: { id: "asc" } } } });
  if (!collection) return null;
  const slugs = new Map((await prisma.collection.findMany({ select: { id: true, slug: true } })).map((c) => [c.id, c.slug]));
  return {
    slug: collection.slug,
    name: collection.name,
    type: collection.type === "view" || collection.type === "singleton" ? collection.type : "base",
    urlPattern: collection.urlPattern,
    fields: collection.fields.map((f) => ({ name: f.name, type: f.type, config: portableConfig(f.type, (f.config ?? {}) as Config, slugs) })),
  };
}

export interface ImportStep { action: string; target: string; detail?: string }

/**
 * Adds the languages a document has and this site doesn't, then their fallbacks, which
 * may name each other. Changes the default only on a site that still has its first
 * language alone, so replaying a schema onto a new database gives the same site.
 */
async function applyLocales(document: SchemaDocument, actorId: string | null) {
  const wanted = document.locales ?? [];
  if (!wanted.length) return;
  const before = await listLocales();
  for (const locale of wanted) {
    if (!before.some((existing) => existing.code === locale.code)) await createLocale({ code: locale.code, label: locale.label, direction: locale.direction, public: locale.public });
  }
  const fresh = before.length === 1 && wanted.length > 0;
  if (fresh && document.defaultLocale && document.defaultLocale !== before[0].code && wanted.some((locale) => locale.code === document.defaultLocale)) await setDefaultLocale(document.defaultLocale, actorId);
  for (const locale of wanted) {
    const stored = (await listLocales()).find((existing) => existing.code === locale.code);
    if (stored && stored.fallback !== locale.fallback) await updateLocale(locale.code, { fallback: locale.fallback });
  }
}
export interface ImportOptions { actorId: string | null; confirm: boolean; deleteMissing: boolean }

const sameFields = (a: DocCollection["fields"], b: DocCollection["fields"]) => isDeepStrictEqual(a, b);
/** Labels a document leaves out are kept, so only ones it gives can differ. */
const otherLabels = (wanted: Labels | null | undefined, current: unknown) => wanted !== undefined && !isDeepStrictEqual(cleanLabels(wanted), current ?? null);

function fieldChanges(wanted: DocCollection["fields"], current: DocCollection["fields"], deleteMissing: boolean) {
  const byName = new Map(current.map((f) => [f.name, f]));
  const added = wanted.filter((f) => !byName.has(f.name)).map((f) => f.name);
  const changed = wanted.filter((f) => byName.has(f.name) && !sameFields([f], [byName.get(f.name)!])).map((f) => f.name);
  const removed = deleteMissing ? current.filter((f) => !wanted.some((w) => w.name === f.name)).map((f) => f.name) : [];
  return { added, changed, removed };
}

/** What an import would change, and every permission that takes. Changes nothing itself. */
export async function planImport(document: SchemaDocument, { deleteMissing }: { deleteMissing: boolean }) {
  const current = await exportSchema({ userFields: true });
  const steps: ImportStep[] = [];
  const required = new Set<Permission>();
  const need = (permission: Permission, step: ImportStep) => { required.add(permission); steps.push(step); };

  const seen = new Set<string>();
  for (const wanted of document.collections) {
    if (seen.has(wanted.slug)) throw new HttpError(400, "BAD_REQUEST", `Collection "${wanted.slug}" appears twice.`);
    seen.add(wanted.slug);
    const existing = current.collections.find((c) => c.slug === wanted.slug);
    if (existing && existing.type !== wanted.type) throw new HttpError(409, "CONFLICT", `"${wanted.slug}" already exists as a ${existing.type} collection.`);
    if (wanted.type === "view" && !wanted.viewQuery) throw new HttpError(400, "BAD_REQUEST", `View "${wanted.slug}" has no query.`);

    if (wanted.type === "view") {
      if (!existing) need("collection:manage-views", { action: "create view", target: wanted.slug });
      else if (existing.viewQuery !== wanted.viewQuery) need("collection:manage-views", { action: "update view", target: wanted.slug });
    } else if (!existing) {
      need("collection:create", { action: "create collection", target: wanted.slug, detail: `${wanted.fields.length} fields` });
    } else {
      const { added, changed, removed } = fieldChanges(wanted.fields, existing.fields, deleteMissing);
      if (added.length + changed.length + removed.length) {
        need("collection:update", { action: "update fields", target: wanted.slug, detail: [added.length && `add ${added.join(", ")}`, changed.length && `change ${changed.join(", ")}`, removed.length && `remove ${removed.join(", ")}`].filter(Boolean).join("; ") });
      }
    }
    if (existing && (existing.name !== wanted.name || existing.description !== wanted.description || otherLabels(wanted.labels, existing.labels))) need("collection:update", { action: "update details", target: wanted.slug });
    if ((existing?.urlPattern ?? null) !== wanted.urlPattern) need("collection:update", { action: "update URL pattern", target: wanted.slug, detail: wanted.urlPattern ?? "none" });
    if (wanted.reviewRequired !== undefined && wanted.reviewRequired !== (existing?.reviewRequired ?? false)) need("collection:update", { action: wanted.reviewRequired ? "require review" : "stop requiring review", target: wanted.slug });
    if (wanted.type !== "view" && wanted.scoped !== undefined && wanted.scoped !== (existing?.scoped ?? false)) need("collection:update", { action: wanted.scoped ? "scope" : "stop scoping", target: wanted.slug });
    if (!isDeepStrictEqual(wanted.rules, existing?.rules ?? { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })) need("collection:manage-rules", { action: "update rules", target: wanted.slug });
    if (existing && wanted.type !== "view" && wanted.localization !== undefined && !isDeepStrictEqual(wanted.localization, existing.localization ?? null)) need("collection:update", { action: wanted.localization ? "update localization" : "turn off localization", target: wanted.slug });
  }

  for (const wanted of document.locales ?? []) {
    const existing = current.locales?.find((locale) => locale.code === wanted.code);
    if (!existing) need("setting:update", { action: "add language", target: wanted.code });
    else if (existing.fallback !== wanted.fallback) need("setting:update", { action: "update language fallback", target: wanted.code, detail: wanted.fallback ?? "default" });
  }

  const managed = await managedBlockNames();
  for (const wanted of document.blocks) {
    if (managed.has(wanted.name)) continue;
    const existing = current.blocks.find((b) => b.name === wanted.name);
    if (!existing) need("collection:create", { action: "create block", target: wanted.name });
    else if (existing.label !== wanted.label || otherLabels(wanted.labels, existing.labels) || existing.icon !== wanted.icon || !sameFields(existing.fields, wanted.fields)) need("collection:update", { action: "update block", target: wanted.name });
  }

  if (document.userFields) {
    const { added, changed, removed } = fieldChanges(document.userFields, current.userFields ?? [], deleteMissing);
    if (added.length + changed.length + removed.length) need("setting:update", { action: "update user fields", target: "users", detail: [...added, ...changed, ...removed].join(", ") });
  }
  return { steps, required: [...required] };
}

/**
 * Applies a document, changing only what differs, so running it again does
 * nothing. Order matters: empty collections first so links can point anywhere,
 * then blocks, fields and views, and rules last because they name all of those.
 * Each step is its own transaction, so after a failure, fix the cause and rerun.
 */
export async function applySchema(document: SchemaDocument, { actorId, confirm, deleteMissing }: ImportOptions) {
  const { steps } = await planImport(document, { deleteMissing });
  if (!steps.length) return steps;

  await applyLocales(document, actorId);

  const existing = await prisma.collection.findMany({ select: { slug: true, id: true, localization: true, scoped: true } });
  const known = new Map(existing.map((c) => [c.slug, c]));
  for (const c of document.collections) {
    if (c.type === "view") continue;
    const stored = known.get(c.slug);
    if (!stored) await createCollectionSchema({ name: c.name, labels: c.labels ?? null, slug: c.slug, description: c.description ?? undefined, type: c.type, fields: [], localization: c.localization ?? null, scoped: c.scoped === true }, actorId);
    else if (c.scoped !== undefined && c.scoped !== stored.scoped) await updateCollectionScope(stored.id, c.scoped, actorId);
    // Before fields, so a field marked localized moves into the collection's translations as it's applied.
    else if (c.localization !== undefined && !isDeepStrictEqual(localizationOf(stored), c.localization)) await updateCollectionLocalization(stored.id, c.localization ?? { enabled: false }, confirm, actorId);
  }
  const collectionIds = async () => new Map((await prisma.collection.findMany({ select: { id: true, slug: true } })).map((c) => [c.slug, c.id]));
  let ids = await collectionIds();

  // Blocks can allow one another, so they all exist before any gets its fields.
  const beforeBlocks = new Set((await prisma.blockType.findMany({ select: { name: true } })).map((b) => b.name));
  for (const b of document.blocks) {
    if (!beforeBlocks.has(b.name)) await createBlockType({ name: b.name, label: b.label, labels: b.labels ?? null, icon: b.icon ?? undefined, fields: [] }, actorId);
  }
  // A plugin's block follows the plugin's code, not the file.
  const managed = await managedBlockNames();
  for (const b of document.blocks) {
    if (managed.has(b.name)) continue;
    const stored = await prisma.blockType.findUniqueOrThrow({ where: { name: b.name } });
    const fields = b.fields.map((f, i) => ({ name: f.name, type: f.type, config: localConfig(f.config, ids, `blocks.${b.name}.fields.${i}`) }));
    await updateBlockType(stored.id, { label: b.label, labels: b.labels, icon: b.icon ?? undefined, fields });
    // Stored blocks are stamped with their version, so a new database must count from the same place.
    if (!beforeBlocks.has(b.name)) await setBlockVersion(b.name, b.version);
  }

  const applyDetails = async (current: { id: number; name: string; description: string | null; labels: unknown }, c: DocCollection) => {
    if (current.name !== c.name || current.description !== c.description || otherLabels(c.labels, current.labels)) await updateCollectionDetails(current.id, { name: c.name, labels: c.labels, description: c.description ?? undefined }, actorId);
  };
  const applyFields = async (c: DocCollection, keepOthers: boolean) => {
    const current = await prisma.collection.findUniqueOrThrow({ where: { slug: c.slug }, include: { fields: { orderBy: { id: "asc" } } } });
    const byName = new Map(current.fields.map((f) => [f.name, f]));
    const requested = c.fields.map((f, i) => ({ id: byName.get(f.name)?.id, name: f.name, type: f.type, config: localConfig(f.config, ids, `collections.${c.slug}.fields.${i}`) }));
    if (keepOthers) for (const f of current.fields) if (!c.fields.some((w) => w.name === f.name)) requested.push({ id: f.id, name: f.name, type: f.type, config: (f.config ?? {}) as Config });
    await updateFieldSchema(current.id, requested, confirm, actorId);
    await applyDetails(current, c);
  };
  const base = document.collections.filter((c) => c.type !== "view");
  // Fields a rule still uses can only go once the new rules are in, so removal waits until the end.
  for (const c of base) await applyFields(c, true);
  // A pattern names fields, so it goes after them.
  for (const c of base) {
    const stored = await prisma.collection.findUniqueOrThrow({ where: { slug: c.slug }, select: { id: true, urlPattern: true, reviewRequired: true } });
    if (stored.urlPattern !== c.urlPattern) await updateCollectionDetails(stored.id, { urlPattern: c.urlPattern }, actorId);
    if (c.reviewRequired !== undefined && stored.reviewRequired !== c.reviewRequired) await updateCollectionDetails(stored.id, { reviewRequired: c.reviewRequired }, actorId);
  }

  for (const c of document.collections.filter((candidate) => candidate.type === "view")) {
    const stored = await prisma.collection.findUnique({ where: { slug: c.slug } });
    if (!stored) await createViewCollection({ name: c.name, labels: c.labels ?? null, slug: c.slug, description: c.description ?? undefined, query: c.viewQuery! }, actorId);
    else {
      if (stored.viewQuery !== c.viewQuery) await updateViewCollection(stored.id, c.viewQuery!, actorId);
      await applyDetails(stored, c);
    }
  }
  ids = await collectionIds();

  if (document.userFields) {
    const current = await listUserFields();
    const requested = document.userFields.map((f) => ({ id: current.find((c) => c.name === f.name)?.id, name: f.name, type: f.type, config: f.config, selfEditable: f.selfEditable }));
    if (!deleteMissing) for (const f of current) if (!document.userFields.some((w) => w.name === f.name)) requested.push({ id: f.id, name: f.name, type: f.type, config: f.config as Config, selfEditable: f.selfEditable });
    await saveUserFields(requested, confirm);
  }

  for (const c of document.collections) await updateRules(ids.get(c.slug)!, c.rules);
  if (deleteMissing) for (const c of base) await applyFields(c, false);
  return steps;
}
