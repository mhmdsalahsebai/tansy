import { z } from "zod";

/** How a value is stored. core/schema/ddl.ts maps each kind to a column on each database. */
export type ColumnType = "text" | "real" | "boolean" | "date" | "datetime" | "integer" | "json";

/** Turns stored values back: SQLite has no boolean or JSON types, and both databases' JSON reaches here as text. */
export function decodeColumn(kind: ColumnType, value: unknown) {
  if (value === null || value === undefined) return null;
  if (kind === "json") return JSON.parse(value as string);
  if (kind === "boolean") return value === 1 || value === true;
  return value;
}

export interface FieldStorage {
  sql: ColumnType;
  /** Target collection id. The record service keeps these links valid. */
  references?: number;
  /** Values are stored file ids. The record service indexes them and applies the field's limits. */
  files?: boolean;
}

/** Config forms submit numbers as strings. */
export const configNumber = (schema = z.number()) =>
  z.preprocess((value) => (typeof value === "string" ? Number(value) : value), schema).optional();

const display = (max: number) => z.string().max(max).optional();

/** Options every field type has. */
export const baseConfig = {
  label: display(200),
  description: display(1000),
  placeholder: display(200),
  hint: display(1000),
  /** The label in other interface languages, by language code, such as { "ar": "العنوان" }. `label` is used for any language missing. */
  labels: z.record(z.string().max(35), z.string().max(200)).optional(),
  /** The description in other interface languages, by language code. */
  descriptions: z.record(z.string().max(35), z.string().max(1000)).optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  readonly: z.boolean().optional(),
  hidden: z.boolean().optional(),
  searchable: z.boolean().optional(),
  /** Holds a value per language, in a collection with localization turned on. Shared by every language otherwise. */
  localized: z.boolean().optional(),
  /** Editor only: shows the field when another field in the same form has a value, or this exact one. The server still validates it. */
  showIf: z.object({ field: z.string().max(63), equals: z.unknown().optional() }).optional(),
  defaultValue: z.unknown().optional(),
};

/** Which built-in control edits this type's values in the dashboard. */
export type FieldInput = "text" | "code" | "number" | "boolean" | "date" | "datetime" | "email" | "url" | "select" | "multiselect" | "reference" | "json" | "richtext" | "stream" | "image" | "file" | "gallery";

/** What the editor shows, including for a type whose plugin has been removed. */
export type EditorInput = FieldInput | "custom" | "unavailable";

export interface FieldAdmin {
  label: string;
  description?: string;
  /** Leave out when the plugin's `defineFieldAdmin` supplies the control. */
  input?: FieldInput;
}

/** What a value links to. `collection` is an id or a slug. Each link gets the same checks as a built-in reference or file field. */
export interface FieldRefs {
  records?: Array<{ collection: number | string; id: number }>;
  files?: string[];
}

/** Filter operators, as written in a filter expression. */
export type FieldOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~" | "?=" | "?!=" | "?>" | "?>=" | "?<" | "?<=" | "?~" | "?!~";

type Config = Record<string, unknown>;

export interface FieldDefinition {
  type: string;
  admin: FieldAdmin;
  config: z.ZodType<Config>;
  value(config: Config): z.ZodType;
  storage(config: Config): FieldStorage;
  /** The shape of stored values, starting at 1. Raise it and add a step to `upgrade`. */
  version?: number;
  /** Steps run once at startup over every stored value, keyed by the version each starts from. */
  upgrade?: Record<number, (value: unknown, config: Config) => unknown>;
  /** Tidies a submitted value before validation. Must accept anything, and leave a normalized value unchanged. */
  normalize?(value: unknown, config: Config): unknown;
  /** The words to index. Without this, strings and lists of strings are indexed. */
  search?(value: never, config: Config): string[];
  /** Links held inside the value, for types that store more than an id. */
  refs?(value: never, config: Config): FieldRefs;
  /** One line for the record grid and revision diffs. */
  summary?(value: never, config: Config): string;
  /** Limits what callers' filters can do with this field. An empty list makes it unfilterable. Rules aren't limited. */
  operators?: readonly FieldOperator[];
  /** False for values that mean the same in every language, so the field can't be marked localized. */
  localizable?: boolean;
}

/**
 * One definition per field type: how the dashboard shows it, its config, value
 * validation and storage. Register custom types in tansy.config.ts. The dashboard
 * builds the config form from the `config` schema.
 */
export function defineField<Shape extends z.ZodRawShape, Value = unknown>(definition: {
  type: string;
  admin: FieldAdmin;
  config: Shape;
  value: (config: z.output<z.ZodObject<Shape>>) => z.ZodType<Value>;
  storage: (config: z.output<z.ZodObject<Shape>>) => FieldStorage;
  version?: number;
  upgrade?: Record<number, (value: unknown, config: z.output<z.ZodObject<Shape>>) => unknown>;
  normalize?: (value: unknown, config: z.output<z.ZodObject<Shape>>) => unknown;
  search?: (value: Value, config: z.output<z.ZodObject<Shape>>) => string[];
  refs?: (value: Value, config: z.output<z.ZodObject<Shape>>) => FieldRefs;
  summary?: (value: Value, config: z.output<z.ZodObject<Shape>>) => string;
  operators?: readonly FieldOperator[];
  localizable?: boolean;
}): FieldDefinition {
  return {
    ...definition,
    config: z.object({ ...baseConfig, ...definition.config }) as unknown as z.ZodType<Config>,
  } as unknown as FieldDefinition;
}

/** Runs the steps between two versions. The result has to be a value the current definition accepts. */
export function upgradedValue(definition: FieldDefinition, config: Config, value: unknown, from: number, to: number) {
  let current = value;
  for (let step = from; step < to; step++) current = definition.upgrade![step](current, config);
  const parsed = definition.value(config).safeParse(current);
  if (!parsed.success) throw new Error(`The upgraded value is invalid: ${parsed.error.issues[0].message}`);
  return current;
}

const UNSTORABLE = "Contains characters that cannot be stored.";
const MAX_JSON_DEPTH = 64;

/** NUL cuts text short in SQLite's string functions, and lone surrogates have no UTF-8 form. */
export const isStorableText = (text: string) => text.isWellFormed() && !text.includes("\u0000");

export function isStorableJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (typeof value === "string") return isStorableText(value);
  if (Array.isArray(value)) return value.every((item) => isStorableJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value).every(([key, item]) => isStorableText(key) && isStorableJson(item, depth + 1));
  }
  return true;
}

export const storedString = () => z.string().refine(isStorableText, UNSTORABLE);
export const storedJson = <T extends z.ZodType>(schema: T) => schema.refine(isStorableJson, UNSTORABLE);

export const checked = <T>(schema: z.ZodType<T>, check: (value: T) => string | null) =>
  schema.superRefine((value, ctx) => {
    const message = check(value);
    if (message) ctx.addIssue({ code: "custom", message });
  });
