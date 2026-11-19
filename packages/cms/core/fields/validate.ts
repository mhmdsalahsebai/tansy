import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../http/errors";
import { getFieldDefinition, isKnownFieldType, normalizedValue, refsProblem, type Issue } from "./registry";

export interface FieldLike {
  name: string;
  type: string;
  config: unknown;
}

interface BaseOptions {
  required?: boolean;
  readonly?: boolean;
  defaultValue?: unknown;
}

const options = (field: FieldLike) => (field.config ?? {}) as Record<string, unknown> & BaseOptions;

/** Forms submit "" for untouched inputs, so it means "no value" for every type. */
export const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

/** Fills missing values on create. Runs before rules, so they see the record that would be saved. */
export function withDefaults(fields: FieldLike[], submitted: Record<string, unknown>): Record<string, unknown> {
  const result = { ...submitted };
  for (const field of fields) {
    const fallback = options(field).defaultValue;
    if (fallback !== undefined && isEmpty(result[field.name]) && isKnownFieldType(field.type)) result[field.name] = fallback;
  }
  return result;
}

const comparable = (field: FieldLike, value: unknown) => {
  if (isEmpty(value)) return null;
  return field.type === "datetime" ? new Date(value as string | Date).getTime() : value;
};

/**
 * Validates values against the collection's field definitions and returns only
 * what may be stored, by field name. On update, omitted fields stay untouched.
 */
export function validateValues(fields: FieldLike[], values: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> {
  const issues: Issue[] = [];
  const clean: Record<string, unknown> = {};

  for (const field of fields) {
    // Nothing can validate a new value once the field's plugin is gone. The stored one stays, and saves of other fields still work.
    if (!isKnownFieldType(field.type)) continue;
    const config = options(field);
    if (!(field.name in values)) {
      if (!existing && config.required) issues.push({ path: field.name, message: "This field is required." });
      continue;
    }
    const value = isEmpty(values[field.name]) ? values[field.name] : normalizedValue(field, values[field.name]);
    if (existing && config.readonly && !isDeepStrictEqual(comparable(field, value), comparable(field, existing[field.name]))) {
      issues.push({ path: field.name, message: "This field is read-only." });
      continue;
    }
    if (isEmpty(value)) {
      if (config.required) issues.push({ path: field.name, message: "This field is required." });
      else clean[field.name] = null;
      continue;
    }
    const result = getFieldDefinition(field.type).value(config).safeParse(value);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => ({ path: [field.name, ...issue.path].join("."), message: issue.message })));
      continue;
    }
    const problem = refsProblem(field, value);
    if (problem) issues.push({ path: field.name, message: problem });
    else clean[field.name] = value;
  }

  if (issues.length) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", issues);
  return clean;
}
