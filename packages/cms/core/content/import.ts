import "server-only";
import { validateRecordValues } from "../blocks/service";
import { fieldStorage } from "../fields/registry";
import { withDefaults } from "../fields/validate";
import type { FileActor } from "../files/refs";
import { badRequest, HttpError } from "../http/errors";
import type { CollectionWithFields } from "./access";
import { createContent, requireContent, updateContent } from "./content-service";
import { parseCsv, type CsvProblem } from "./csv";
import { recordsDb } from "./db";
import { readSource } from "../i18n/storage";

/**
 * Bringing records in from a CSV file or a list of rows. Each row goes through the same
 * validation, hooks, history, search and review as a save in the dashboard, one row per
 * transaction, so a large file can't hold the write lock. Nothing here uploads files: a
 * file or reference column names ids that already exist.
 *
 * The import needs the record permissions (`record:create`, and `record:update` to match
 * existing records). API rules don't open it, as they don't open a schema import.
 */

/** Per request, so one import stays bounded. A larger file is sent in several requests. */
export const MAX_IMPORT_ROWS = 2_000;
/** How many row results come back, so a failing file doesn't answer with megabytes. */
const MAX_REPORTED = 500;
/** Rows shown in a preview, so a mapping can be judged against real values. */
const SAMPLE_ROWS = 5;

export interface ImportInput {
  /** A CSV file's text. Its header names the columns. */
  csv?: string;
  /** Or rows already parsed, by column name, with values already typed where they aren't text. */
  rows?: Array<Record<string, unknown>>;
  /** Column name to field name. Columns are taken as field names where this doesn't name them. */
  mapping?: Record<string, string>;
  /** A unique field to match an existing record on, which is then updated instead of created. */
  keyField?: string;
  status?: "draft" | "published";
  /** Check every row and write nothing. */
  dryRun?: boolean;
  /** "stop" (the default) keeps what landed and stops at the first bad row. "skip" goes on. */
  onError?: "stop" | "skip";
}

export type ImportAction = "created" | "updated" | "failed";

export interface ImportRowResult {
  /** The row's line in the file, counting the header, so it can be found again. */
  row: number;
  action: ImportAction;
  id?: number;
  error?: string;
  field?: string;
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  failed: number;
  /** Rows not reached, because a row failed and `onError` was "stop". */
  remaining: number;
  rows: ImportRowResult[];
  /** What was wrong with the file itself, such as a column with no name. */
  problems?: CsvProblem[];
}

type Field = CollectionWithFields["fields"][number];

const multipleOf = (field: Field) => fieldStorage(field).sql === "json" && Boolean(fieldStorage(field).references ?? fieldStorage(field).files);

/** Splits a cell holding several values, as a spreadsheet writes them: "1,2" or "a, b". */
const split = (text: string) => text.split(",").map((part) => part.trim()).filter((part) => part !== "");

const cellProblem = (field: Field, message: string) => new HttpError(400, "VALIDATION_FAILED", message, [{ path: field.name, message }]);

/**
 * A cell as the field's own kind of value. Text comes from a CSV file, where everything is a
 * string; a value that isn't text, as JSON rows carry, is passed through for the field to
 * validate. An empty cell is no value, so a column left blank doesn't overwrite a default.
 */
export function coerceImported(field: Field, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text === "") return null;
  const storage = fieldStorage(field);
  if (storage.references) {
    const ids = split(text).map((part) => {
      const id = Number(part);
      if (!Number.isInteger(id) || id <= 0) throw cellProblem(field, `"${part}" isn't a record id.`);
      return id;
    });
    return multipleOf(field) ? ids : ids[0] ?? null;
  }
  if (storage.files) return multipleOf(field) ? split(text) : text;
  switch (storage.sql) {
    case "integer":
    case "real": {
      const value = Number(text);
      if (!Number.isFinite(value)) throw cellProblem(field, `"${text}" isn't a number.`);
      return value;
    }
    case "boolean": {
      const yes = ["true", "1", "yes", "y", "on"];
      const no = ["false", "0", "no", "n", "off"];
      const value = text.toLowerCase();
      if (yes.includes(value)) return true;
      if (no.includes(value)) return false;
      throw cellProblem(field, `"${text}" isn't true or false.`);
    }
    case "datetime": {
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) throw cellProblem(field, `"${text}" isn't a date.`);
      return date.toISOString();
    }
    case "json": {
      try {
        return JSON.parse(text);
      } catch {
        throw cellProblem(field, "This column holds JSON, and this cell isn't valid JSON.");
      }
    }
    default:
      return raw;
  }
}

/** Which field each column goes to. A column naming no field is refused up front, so a typo isn't silently dropped. */
function resolveColumns(collection: CollectionWithFields, columns: string[], mapping: Record<string, string> = {}) {
  const byName = new Map(collection.fields.map((field) => [field.name, field]));
  const resolved = new Map<string, Field>();
  const unknown: string[] = [];
  for (const column of columns) {
    const target = mapping[column] ?? column;
    // An empty mapping means "leave this column out".
    if (target === "") continue;
    const field = byName.get(target);
    if (!field) unknown.push(column);
    else resolved.set(column, field);
  }
  if (unknown.length) throw badRequest(`This collection has no field for ${unknown.slice(0, 5).map((name) => `"${name.slice(0, 60)}"`).join(", ")}. Map or leave out these columns.`);
  return resolved;
}

/**
 * The record this row updates, found by the key field, or null to create one. Read through the
 * same source a request in this language uses, so a localized collection's key field can live in
 * its translation. The scope plugin keeps the lookup inside the caller's own scope value.
 */
async function findByKey(collection: CollectionWithFields, field: Field, value: unknown) {
  if (value === null || value === undefined) throw cellProblem(field, "The column matching existing records can't be empty.");
  const rows = await recordsDb.selectFrom(await readSource(collection)).select("id").where(field.name, "=", value as never).limit(2).execute();
  if (rows.length > 1) throw cellProblem(field, "More than one record already has this value.");
  return rows.length ? (rows[0].id as number) : null;
}

function keyFieldOf(collection: CollectionWithFields, name: string | undefined) {
  if (!name) return null;
  const field = collection.fields.find((candidate) => candidate.name === name);
  if (!field) throw badRequest(`This collection has no field called "${name.slice(0, 60)}".`);
  if (!(field.config as { unique?: boolean } | null)?.unique) throw badRequest(`"${field.name}" isn't unique, so it can't be used to match existing records.`);
  if (multipleOf(field) || fieldStorage(field).sql === "json") throw badRequest(`"${field.name}" can't be used to match existing records.`);
  return field;
}

const message = (error: unknown) => (error instanceof HttpError ? error.message : "Something went wrong.");
const fieldOf = (error: unknown) => {
  const details = error instanceof HttpError ? (error.details as Array<{ path?: string }> | undefined) : undefined;
  return details?.[0]?.path || undefined;
};

/** The file as columns and rows, whichever way it came, with its own problems refused. */
function parseTable(input: ImportInput) {
  if ((input.csv === undefined) === (input.rows === undefined)) throw badRequest("Send either csv or rows.");
  const table = input.csv !== undefined
    ? parseCsv(input.csv)
    : { columns: [...new Set(input.rows!.flatMap((row) => Object.keys(row)))], rows: input.rows! as Array<Record<string, unknown>>, problems: [] as CsvProblem[] };
  const fatal = table.problems.find((problem) => /empty|never closed|no name|more than one column/.test(problem.message));
  if (fatal) throw new HttpError(400, "VALIDATION_FAILED", fatal.message, table.problems.map((problem) => ({ path: `line ${problem.line}`, message: problem.message })));
  if (table.rows.length > MAX_IMPORT_ROWS) throw badRequest(`An import takes at most ${MAX_IMPORT_ROWS} rows at a time. This file has ${table.rows.length}.`);
  if (!table.rows.length) throw badRequest("This file has a header but no rows.");
  return table;
}

/**
 * What the file holds, before anything is written: its columns, the field each one would go to
 * where the name already matches, and its first few rows, so the dashboard can show a mapping.
 */
export function previewImport(collection: CollectionWithFields, input: ImportInput) {
  const table = parseTable(input);
  const names = new Set(collection.fields.map((field) => field.name));
  return {
    columns: table.columns,
    total: table.rows.length,
    /** Column name to field name, empty where no field has that name and a choice is needed. */
    mapping: Object.fromEntries(table.columns.map((column) => [column, names.has(column) ? column : ""])),
    sample: table.rows.slice(0, SAMPLE_ROWS),
    ...(table.problems.length ? { problems: table.problems } : {}),
  };
}

/**
 * Reads the input into rows of values by field name. Separate from writing them, so a dry run
 * and the real import see exactly the same rows.
 */
export function readImport(collection: CollectionWithFields, input: ImportInput) {
  const table = parseTable(input);
  const columns = resolveColumns(collection, table.columns, input.mapping);
  if (!columns.size) throw badRequest("No column maps to a field.");
  return { table, columns };
}

/**
 * Imports the rows. Each row is validated and written on its own, so the result says what
 * happened to each one; `dryRun` validates everything and writes nothing. The first row of
 * the file is line 2, after the header.
 */
export async function importRecords(collection: CollectionWithFields, input: ImportInput, createdById: string | null, actor: FileActor, canUpdate: boolean): Promise<ImportResult> {
  const { table, columns } = readImport(collection, input);
  const key = keyFieldOf(collection, input.keyField);
  const keyColumn = key ? [...columns].find(([, field]) => field.id === key.id)?.[0] : undefined;
  if (key && !keyColumn) throw badRequest(`No column maps to "${key.name}", so existing records can't be matched.`);
  const dryRun = input.dryRun === true;
  const stopOnError = input.onError !== "skip";

  const results: ImportRowResult[] = [];
  let created = 0;
  let updated = 0;
  let failed = 0;
  let index = 0;

  for (; index < table.rows.length; index++) {
    const line = index + 2;
    const raw = table.rows[index];
    try {
      const values: Record<string, unknown> = {};
      for (const [column, field] of columns) {
        if (!Object.hasOwn(raw, column)) continue;
        values[field.name] = coerceImported(field, raw[column]);
      }
      const existingId = key && keyColumn ? await findByKey(collection, key, values[key.name]) : null;
      if (existingId !== null && !canUpdate) throw new HttpError(403, "FORBIDDEN", "This row matches an existing record, and you may not update records here.");

      if (existingId === null) {
        const candidate = withDefaults(collection.fields, values);
        const clean = await validateRecordValues(collection.fields, candidate);
        if (!dryRun) {
          const row = await createContent(collection, input.status, clean, createdById, actor);
          results.push({ row: line, action: "created", id: row.id });
        } else results.push({ row: line, action: "created" });
        created++;
      } else {
        const item = await requireContent(collection, existingId);
        const clean = await validateRecordValues(collection.fields, values, item);
        if (!dryRun) await updateContent(collection, item, input.status, clean, actor, "Imported");
        results.push({ row: line, action: "updated", id: existingId });
        updated++;
      }
    } catch (error) {
      failed++;
      results.push({ row: line, action: "failed", error: message(error), field: fieldOf(error) });
      if (stopOnError) {
        index++;
        break;
      }
    }
  }

  return {
    dryRun,
    total: table.rows.length,
    created,
    updated,
    failed,
    remaining: table.rows.length - index,
    rows: results.slice(0, MAX_REPORTED),
    ...(table.problems.length ? { problems: table.problems } : {}),
  };
}

/** The columns a collection can be imported into, for the dashboard's mapping. */
export const importableFields = (collection: CollectionWithFields) =>
  collection.fields.map((field) => ({
    name: field.name,
    type: field.type,
    multiple: multipleOf(field),
    required: (field.config as { required?: boolean } | null)?.required === true,
    unique: (field.config as { unique?: boolean } | null)?.unique === true,
    /** A stream field's blocks have to come in as JSON, so a spreadsheet can't fill one. */
    json: fieldStorage(field).sql === "json" && !multipleOf(field),
  }));
