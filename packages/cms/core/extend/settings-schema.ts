import { z } from "zod";
import type { PluginSettingField } from "./define";

const SETTING_NAME = /^[a-z][A-Za-z0-9_]{0,39}$/;

function fieldSchema(field: PluginSettingField): z.ZodType {
  switch (field.type) {
    case "boolean": return z.boolean();
    case "number": {
      let schema = field.integer ? z.number().int() : z.number();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return schema;
    }
    case "text": return z.string().max(field.maxLength ?? 2000);
    case "select": return z.enum(field.options.map((option) => option.value) as [string, ...string[]]);
    case "secret": return z.string().max(4000);
  }
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;

/** A secret's default is that it isn't set. */
const defaultOf = (field: PluginSettingField) => (field.type === "secret" ? "" : field.default);

/** Validates a full set of values. Unknown names are refused. */
export function settingsSchema(fields: PluginSettingField[]) {
  return z.strictObject(Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field)])));
}

/** Each saved value that still fits its field, then defaults for the rest, so a field whose limits changed falls back rather than failing. */
export function resolveSettings(fields: PluginSettingField[], saved: unknown): Record<string, unknown> {
  const stored = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  return Object.fromEntries(fields.map((field) => {
    const value = Object.hasOwn(stored, field.name) ? fieldSchema(field).safeParse(stored[field.name]) : null;
    return [field.name, value?.success ? value.data : defaultOf(field)];
  }));
}

/** What's wrong with the declared fields, or null. */
export function settingsProblem(fields: PluginSettingField[]): string | null {
  const seen = new Set<string>();
  for (const field of fields) {
    if (!SETTING_NAME.test(field.name)) return `setting "${field.name}" needs a name of letters, digits and underscores, starting with a lowercase letter.`;
    if (seen.has(field.name)) return `setting "${field.name}" is listed twice.`;
    seen.add(field.name);
    if (!field.label?.trim()) return `setting "${field.name}" needs a label.`;
    if (field.perScope !== undefined && typeof field.perScope !== "boolean") return `setting "${field.name}": perScope must be true or false.`;
    if (field.type === "select" && !field.options?.length) return `setting "${field.name}" needs options.`;
    if (!["boolean", "number", "text", "select", "secret"].includes(field.type)) return `setting "${field.name}" has an unknown type "${String((field as { type: unknown }).type)}".`;
    if (field.type === "secret") {
      if ((field as { default?: unknown }).default !== undefined) return `setting "${field.name}": a secret can't have a default.`;
      if (field.env !== undefined && !ENV_NAME.test(field.env)) return `setting "${field.name}": env must be an environment variable name, such as STRIPE_SECRET_KEY.`;
      continue;
    }
    if (field.type === "text" && field.suggestions !== undefined) {
      const { route, with: params = [] } = field.suggestions ?? {};
      if (typeof route !== "string" || !/^\/[A-Za-z0-9._/-]*$/.test(route)) return `setting "${field.name}": suggestions.route must be one of the plugin's paths, such as "/models".`;
      for (const name of params) {
        const other = fields.find((candidate) => candidate.name === name);
        if (!other || other.type === "secret") return `setting "${field.name}": suggestions.with can only name the plugin's other settings that aren't secrets. "${String(name)}" isn't one.`;
      }
    }
    const parsed = fieldSchema(field).safeParse(field.default);
    if (!parsed.success) return `setting "${field.name}": its default doesn't fit. ${parsed.error.issues[0].message}`;
  }
  return null;
}
