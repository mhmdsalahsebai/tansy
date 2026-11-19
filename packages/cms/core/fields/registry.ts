import { z } from "zod";
import type { CmsConfig } from "../auth/extensions";
import { getCmsConfig } from "../config";
import { builtinFields } from "./builtin";
import type { ColumnType, EditorInput, FieldDefinition, FieldStorage } from "./define";

export interface Issue {
  path: string;
  message: string;
}

const TYPE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

function assertUpgradePath({ type, version = 1, upgrade }: FieldDefinition) {
  if (!Number.isInteger(version) || version < 1) throw new Error(`Field type "${type}": version must be a whole number from 1.`);
  for (let step = 1; step < version; step++) {
    if (!upgrade || !Object.hasOwn(upgrade, step)) throw new Error(`Field type "${type}" is version ${version}, but has no upgrade step from version ${step}.`);
  }
}

/** Custom types come from tansy.config.ts. A clash stops startup rather than silently replacing a type. */
export function buildRegistry(custom: FieldDefinition[]) {
  const registry = new Map<string, FieldDefinition>();
  for (const field of [...builtinFields, ...custom]) {
    if (!TYPE_NAME.test(field.type)) throw new Error(`Invalid field type name "${field.type}".`);
    if (registry.has(field.type)) throw new Error(`Field type "${field.type}" is registered twice.`);
    assertUpgradePath(field);
    registry.set(field.type, field);
  }
  return registry;
}

let built: { config: CmsConfig; registry: ReturnType<typeof buildRegistry> } | undefined;

/** Built on first use, once an entry file has provided the config. Startup calls it through assertConfiguredExtensions, so a clash still stops the server. */
function definitions() {
  const config = getCmsConfig();
  if (built?.config !== config) built = { config, registry: buildRegistry([...(config.fields ?? []), ...(config.plugins ?? []).flatMap((plugin) => plugin.fields ?? [])]) };
  return built.registry;
}

/** Types whose stored values may need rewriting at startup. */
export const versionedFieldTypes = () => [...definitions().values()].filter((definition) => (definition.version ?? 1) > 1);

export const fieldTypeNames = () => [...definitions().keys()];

/** What the dashboard needs to offer each type and generate its config form. */
export const fieldCatalogue = () => {
  const owners = new Map((getCmsConfig().plugins ?? []).flatMap((plugin) => (plugin.fields ?? []).map((field) => [field.type, plugin.name] as const)));
  return [...definitions().values()].map(({ type, admin, config, localizable, operators }) => ({
    type,
    ...admin,
    /** The plugin that registered it, whose `messages` name it under `fieldTypes.<type>`. */
    ...(owners.has(type) ? { plugin: owners.get(type) } : {}),
    localizable: localizable !== false,
    /** The only filter operators the type takes, when it limits them. */
    ...(operators ? { operators: [...operators] } : {}),
    input: admin.input ?? ("custom" as const),
    configSchema: z.toJSONSchema(config, { unrepresentable: "any" }),
  }));
};

export function getFieldDefinition(type: string): FieldDefinition {
  const definition = definitions().get(type);
  if (!definition) throw new Error(`Unknown field type "${type}".`);
  return definition;
}

export const isKnownFieldType = (type: string) => definitions().has(type);

export function editorInput(type: string): EditorInput {
  const definition = definitions().get(type);
  return definition ? (definition.admin.input ?? "custom") : "unavailable";
}

type FieldRef = { type: string; config?: unknown };
const configOf = (field: FieldRef) => (field.config ?? {}) as Record<string, unknown>;

/** A failed normalize leaves the value as submitted, and validation then judges it. */
export function normalizedValue(field: FieldRef, value: unknown): unknown {
  const normalize = definitions().get(field.type)?.normalize;
  if (!normalize) return value;
  try {
    return normalize(value, configOf(field));
  } catch {
    return value;
  }
}

const MAX_REFS = 1000;
const NO_REFS = { records: [], files: [] };

export interface ValueRefs {
  records: Array<{ collection: number | string; id: number }>;
  files: string[];
}

export const hasValueRefs = (type: string) => definitions().get(type)?.refs !== undefined;

function readRefs(field: FieldRef, value: unknown): ValueRefs {
  const refs = definitions().get(field.type)?.refs;
  if (!refs || value === undefined || value === null) return NO_REFS;
  const { records = [], files = [] } = refs(value as never, configOf(field));
  if (records.length + files.length > MAX_REFS) throw new Error(`A value can link to at most ${MAX_REFS} records and files.`);
  for (const { collection, id } of records) {
    if (!Number.isSafeInteger(id) || id < 1 || (typeof collection !== "string" && !Number.isSafeInteger(collection))) throw new Error("A link names an invalid record.");
  }
  if (files.some((file) => typeof file !== "string" || file === "")) throw new Error("A link names an invalid file.");
  return { records, files };
}

/** Why a validated value's links can't be read. Runs before saving, so a value that can't report its links can't be stored without them. */
export function refsProblem(field: FieldRef, value: unknown): string | null {
  try {
    readRefs(field, value);
    return null;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "The links in this value could not be read.";
  }
}

/** The links in a value. An older stored shape the plugin can't read has none, so a read never fails on it. */
export function valueRefs(field: FieldRef, value: unknown): ValueRefs {
  try {
    return readRefs(field, value);
  } catch {
    return NO_REFS;
  }
}

const plainText = (value: unknown) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The words to index for a value. A search function that fails indexes nothing, and the save goes ahead. */
export function searchableText(field: FieldRef, value: unknown): string[] {
  const search = definitions().get(field.type)?.search;
  if (!search) return plainText(value);
  try {
    return search(value as never, configOf(field)).filter((item) => typeof item === "string");
  } catch {
    return [];
  }
}

const MAX_SUMMARY = 500;

/** One line describing a value, for types that declare `summary`. */
export function valueSummary(field: FieldRef, value: unknown): string | undefined {
  const summary = definitions().get(field.type)?.summary;
  if (!summary || value === undefined || value === null) return undefined;
  try {
    const text = summary(value as never, configOf(field));
    return typeof text === "string" ? text.slice(0, MAX_SUMMARY) : undefined;
  } catch {
    return undefined;
  }
}

/** The operators callers may use on a type. Undefined means all of them. */
export const fieldOperators = (type: string) => definitions().get(type)?.operators;

/** How a stored field's column is read. A removed plugin's field falls back to the kind saved with it, so its values stay readable. */
export function fieldStorage(field: { type: string; config?: unknown; storage?: string | null }): FieldStorage {
  const definition = definitions().get(field.type);
  return definition ? definition.storage((field.config ?? {}) as Record<string, unknown>) : { sql: (field.storage ?? "text") as ColumnType };
}

/** The collection a stored field links to, if any. */
export const referencedCollection = (type: string, config: unknown) =>
  definitions().get(type)?.storage((config ?? {}) as Record<string, unknown>).references;

export type ResolvedConfig =
  | { ok: true; config: Record<string, unknown>; storage: FieldStorage; unique: boolean; localized: boolean }
  | { ok: false; issues: Issue[] };

/** Validates a field's config. Blank form inputs count as unset. */
export function resolveFieldConfig(type: string, raw: unknown): ResolvedConfig {
  const definition = definitions().get(type);
  if (!definition) return { ok: false, issues: [{ path: "type", message: `Unknown field type "${type}".` }] };

  const present = Object.entries((raw ?? {}) as Record<string, unknown>).filter(([, value]) => value !== "" && value !== null);
  const parsed = definition.config.safeParse(Object.fromEntries(present));
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: ["config", ...issue.path].join("."), message: issue.message })) };
  }

  const config = parsed.data;
  const storage = definition.storage(config);
  const issues: Issue[] = [];
  if (config.unique && storage.sql === "json") issues.push({ path: "config.unique", message: "This field type cannot be unique." });
  if (config.localized && definition.localizable === false) issues.push({ path: "config.localized", message: "This field type means the same in every language, so it can't be localized." });
  if (config.defaultValue !== undefined) {
    const result = definition.value(config).safeParse(config.defaultValue);
    if (!result.success) issues.push({ path: "config.defaultValue", message: result.error.issues[0].message });
  }
  return issues.length ? { ok: false, issues } : { ok: true, config, storage, unique: config.unique === true, localized: config.localized === true };
}
