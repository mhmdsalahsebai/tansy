import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import prisma from "../../lib/prisma";
import { applySchema, addCollectionFields } from "../schema/portable";
import { fieldNameProblem, SLUG_MAX } from "../schema/names";

/**
 * better-auth plugins that a CMS plugin adds can declare their own tables, such as the
 * Stripe plugin's `subscription`, and their own columns on core tables, such as
 * `user.stripeCustomerId`. The Prisma client ships generated with the package, so it
 * knows neither. Instead of new tables beside core's, each becomes a collection named
 * with the CMS plugin's prefix. Core's tables never change, and the data shows in the
 * dashboard, follows rules and fires hooks like any other record.
 */

export type AuthFieldType = "string" | "number" | "boolean" | "date" | "json" | "string[]" | "number[]" | Array<string | number>;

export interface PluginField {
  /** better-auth's name. */
  name: string;
  /** The collection field holding it. */
  column: string;
  type: AuthFieldType;
  unique: boolean;
}

export interface PluginModel {
  /** The CMS plugin whose `auth.plugins` declared it. Writes are audited under its name. */
  plugin: string;
  /** better-auth's model key, such as "subscription" or "user". */
  model: string;
  /** Other names better-auth may address the model by, from a plugin's `schema` option. */
  aliases: string[];
  slug: string;
  /**
   * "model": a table of the plugin's own, one record per row, with better-auth's id in `authId`.
   * "fields": columns a plugin adds to a core table, one record per core row, keyed by `coreId`.
   */
  kind: "model" | "fields";
  fields: PluginField[];
}

/** better-auth's id, which is text, while record ids are numbers. */
export const AUTH_ID = "authId";
/** The core row a "fields" record belongs to. */
export const ROW_ID = "coreId";

/** Tables and columns the generated Prisma client knows, by better-auth's model key. */
export function prismaModels(): Map<string, Set<string>> {
  const dataModel = (prisma as unknown as { _runtimeDataModel?: { models: Record<string, { fields: Array<{ name: string; kind: string }> }> } })._runtimeDataModel;
  if (!dataModel) throw new Error("The Prisma client has no data model to compare better-auth plugins against.");
  return new Map(Object.entries(dataModel.models).map(([name, { fields }]) => [
    name.charAt(0).toLowerCase() + name.slice(1),
    new Set(fields.filter((field) => field.kind !== "object").map((field) => field.name)),
  ]));
}

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "");
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The collection field for a better-auth field. Names records reserve, such as `status`, get the model's name in front. */
export function columnFor(model: string, name: string) {
  if (name === "id") return AUTH_ID;
  return fieldNameProblem(name) ? `${model}${capital(name)}` : name;
}

type Schema = NonNullable<BetterAuthPlugin["schema"]>;

/**
 * What each CMS plugin's better-auth plugins need that core's tables don't have.
 * Throws on anything that couldn't be stored faithfully, so a plugin fails at startup
 * rather than losing data later.
 */
export function planPluginModels(extensions: Array<{ name: string; plugins: BetterAuthPlugin[] }>, core: Map<string, Set<string>>): PluginModel[] {
  const plans = new Map<string, PluginModel>();
  for (const { name: plugin, plugins } of extensions) {
    for (const authPlugin of plugins) {
      for (const [model, table] of Object.entries((authPlugin.schema ?? {}) as Schema)) {
        if (table.disableMigration) continue;
        const known = core.get(model);
        const fields = Object.entries(table.fields ?? {}).filter(([field]) => !known?.has(field));
        if (known && !fields.length) continue;
        const kind = known ? "fields" : "model";
        const owner = [...plans.values()].find((plan) => plan.model === model && plan.plugin !== plugin);
        if (owner) throw new Error(`Plugin "${plugin}": better-auth model "${model}" is already declared by plugin "${owner.plugin}".`);
        const slug = `${plugin}-${kebab(model)}${kind === "fields" ? "-data" : ""}`;
        if (slug.length > SLUG_MAX) throw new Error(`Plugin "${plugin}": the collection for better-auth model "${model}" would need a name longer than ${SLUG_MAX} characters.`);
        const plan = plans.get(slug) ?? { plugin, model, aliases: [], slug, kind, fields: [] };
        if (table.modelName && table.modelName !== model && !plan.aliases.includes(table.modelName)) plan.aliases.push(table.modelName);
        for (const [field, attribute] of fields) {
          if (attribute.fieldName && attribute.fieldName !== field) throw new Error(`Plugin "${plugin}": renaming better-auth field "${model}.${field}" isn't supported. Its collection field is named after it.`);
          if (plan.fields.some((existing) => existing.name === field)) continue;
          plan.fields.push({ name: field, column: columnFor(model, field), type: attribute.type as AuthFieldType, unique: attribute.unique === true });
        }
        const columns = [kind === "model" ? AUTH_ID : ROW_ID, ...plan.fields.map((field) => field.column)];
        const clash = columns.find((column, index) => columns.indexOf(column) !== index || fieldNameProblem(column));
        if (clash) throw new Error(`Plugin "${plugin}": better-auth model "${model}" has fields that can't all be stored, at "${clash}".`);
        plans.set(slug, plan);
      }
    }
  }
  return [...plans.values()];
}

function collectionField(field: PluginField) {
  const config: Record<string, unknown> = field.unique ? { unique: true } : {};
  switch (field.type) {
    case "number": return { name: field.column, type: "number", config };
    case "boolean": return { name: field.column, type: "boolean", config };
    case "date": return { name: field.column, type: "datetime", config };
    case "json":
    case "string[]":
    case "number[]": return { name: field.column, type: "json", config };
    default: return { name: field.column, type: "text", config };
  }
}

function collectionFields(plan: PluginModel) {
  const key = { name: plan.kind === "model" ? AUTH_ID : ROW_ID, type: "text", config: { unique: true, required: true, description: plan.kind === "model" ? "better-auth's id for this row." : `The ${plan.model} this belongs to.` } };
  return [key, ...plan.fields.map(collectionField)];
}

const title = (plan: PluginModel) => (plan.kind === "model" ? capital(plan.model.replace(/([a-z0-9])([A-Z])/g, "$1 $2")) : `${capital(plan.model)} data`);

/**
 * Creates each collection that's missing, locked so only staff with record permissions
 * reach it, and adds fields a newer plugin version declares. Never changes rules,
 * names or fields an owner edited, and never removes anything.
 */
export async function ensurePluginCollections(plans: PluginModel[]) {
  if (!plans.length) return;
  const existing = new Set((await prisma.collection.findMany({ where: { slug: { in: plans.map((plan) => plan.slug) } }, select: { slug: true } })).map((c) => c.slug));
  const missing = plans.filter((plan) => !existing.has(plan.slug));
  if (missing.length) {
    const locked = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
    try {
      await applySchema({
        version: 1,
        blocks: [],
        collections: missing.map((plan) => ({
          slug: plan.slug,
          name: title(plan),
          description: `Kept by the ${plan.plugin} plugin's sign-in features. Staff with record permissions can read it. Edit with care: the plugin reads and writes these fields.`,
          type: "base",
          viewQuery: null,
          urlPattern: null,
          rules: locked,
          fields: collectionFields(plan),
        })),
      }, { actorId: null, confirm: false, deleteMissing: false });
    } catch (error) {
      // Another instance may have created them first. Anything else still fails.
      const now = await prisma.collection.count({ where: { slug: { in: missing.map((plan) => plan.slug) } } });
      if (now !== missing.length) throw error;
    }
  }
  for (const plan of plans.filter((plan) => existing.has(plan.slug))) await addCollectionFields(plan.slug, collectionFields(plan), null);
}
