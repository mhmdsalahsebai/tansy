import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { decodeColumn, upgradedValue, type FieldDefinition, type FieldRefs } from "./define";

export interface FieldTestCases {
  config?: Record<string, unknown>;
  /** Values the field must accept and store unchanged. */
  valid: unknown[];
  /** Values the field must refuse. */
  invalid?: unknown[];
  /** For a type with `refs`: a valid value and the links it should report. */
  refs?: Array<{ value: unknown; expected: FieldRefs }>;
  /** Stored values from older versions, which must upgrade to something the current definition accepts. */
  upgrades?: Array<{ from: number; value: unknown; expected?: unknown }>;
}

const hasNul = (value: unknown) => JSON.stringify(value)?.includes("\\u0000") === true;

/** What each database gives back for a stored value. Postgres refuses NUL, so a value holding one could never be saved there. */
function roundTripProblem(sql: string, value: unknown) {
  if (hasNul(value)) return "holds a NUL character, which Postgres can't store";
  if (sql === "json") return isDeepStrictEqual(decodeColumn("json", JSON.stringify(value)), value) ? null : "changes when stored as JSON";
  if (sql === "boolean") return typeof value === "boolean" ? null : "isn't a boolean, so it can't be stored in a boolean column";
  if (sql === "integer" || sql === "real") return typeof value === "number" ? null : `isn't a number, so it can't be stored in a ${sql} column`;
  return typeof value === "string" ? null : `isn't text, so it can't be stored in a ${sql} column`;
}

/**
 * Checks a field definition, for a plugin's own test suite. Returns the problems
 * found, so it works with any test runner: `expect(testFieldDefinition(...)).toEqual([])`.
 */
export function testFieldDefinition(definition: FieldDefinition, cases: FieldTestCases): string[] {
  const parsed = definition.config.safeParse(cases.config ?? {});
  if (!parsed.success) return [`config is refused: ${parsed.error.issues[0].message}`];
  const config = parsed.data;
  const problems: string[] = [];
  const label = (value: unknown) => JSON.stringify(value);
  const schema = definition.value(config);
  const { sql } = definition.storage(config);

  try {
    z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  } catch (error) {
    problems.push(`has no JSON Schema, so generated types can't describe it: ${(error as Error).message}`);
  }

  for (const submitted of cases.valid) {
    const value = definition.normalize ? definition.normalize(submitted, config) : submitted;
    if (definition.normalize && !isDeepStrictEqual(definition.normalize(value, config), value)) problems.push(`normalize changes ${label(value)} a second time`);
    const result = schema.safeParse(value);
    if (!result.success) {
      problems.push(`refuses ${label(value)}: ${result.error.issues[0].message}`);
      continue;
    }
    const problem = roundTripProblem(sql, value);
    if (problem) problems.push(`${label(value)} ${problem}`);
    for (const [name, hook] of [["search", definition.search], ["summary", definition.summary], ["refs", definition.refs]] as const) {
      try {
        (hook as ((input: unknown, options: unknown) => unknown) | undefined)?.(value, config);
      } catch (error) {
        problems.push(`${name} fails on ${label(value)}: ${(error as Error).message}`);
      }
    }
  }

  for (const value of cases.invalid ?? []) {
    const normalized = definition.normalize ? definition.normalize(value, config) : value;
    if (schema.safeParse(normalized).success) problems.push(`accepts ${label(value)}`);
  }

  for (const { value, expected } of cases.refs ?? []) {
    const actual = (definition.refs as ((input: unknown, options: unknown) => FieldRefs) | undefined)?.(value, config) ?? {};
    const same = isDeepStrictEqual(actual.records ?? [], expected.records ?? []) && isDeepStrictEqual(actual.files ?? [], expected.files ?? []);
    if (!same) problems.push(`refs of ${label(value)} are ${label(actual)}, expected ${label(expected)}`);
  }
  for (const { from, value, expected } of cases.upgrades ?? []) {
    try {
      const upgraded = upgradedValue(definition, config, value, from, definition.version ?? 1);
      if (expected !== undefined && !isDeepStrictEqual(upgraded, expected)) problems.push(`upgrading ${label(value)} gives ${label(upgraded)}, expected ${label(expected)}`);
    } catch (error) {
      problems.push(`can't upgrade ${label(value)} from version ${from}: ${(error as Error).message}`);
    }
  }
  return problems;
}
