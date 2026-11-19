import Database from "better-sqlite3";
import { HttpError } from "../http/errors";
import { SYSTEM_COLUMNS_FOR_VIEWS, createViewSql } from "./ddl";
import { fieldNameProblem } from "./names";

export const MAX_VIEW_QUERY = 10_000;

/** Built-ins that exist in every database, so preparing against a copy of the schema can't exclude them. */
const FORBIDDEN = /\b(sqlite_\w*|pragma_\w*|dbstat|load_extension)\b/i;

export interface ViewColumn {
  name: string;
  /** Where the value comes from, when it's a plain column. */
  table: string | null;
  column: string | null;
}

const refuse = (message: string) => new HttpError(400, "INVALID_VIEW_QUERY", message, [{ path: "query", message }]);

/** The same on every database: unique names that work as fields, and an id. */
export function checkViewColumns(columns: ViewColumn[]) {
  const seen = new Set<string>();
  for (const { name } of columns) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw refuse(`Column "${name.slice(0, 63)}" appears twice. Give each column its own name.`);
    seen.add(lower);
  }
  if (!seen.has("id")) throw refuse('Must return a column named "id", such as a unique record id.');
  for (const { name } of columns) {
    if (SYSTEM_COLUMNS_FOR_VIEWS.includes(name.toLowerCase())) continue;
    const problem = fieldNameProblem(name);
    if (problem) throw refuse(`Column "${name.slice(0, 63)}": ${problem} Add an alias with AS.`);
  }
  return columns;
}

/**
 * Checks a view's SQL against an empty in-memory database holding only record
 * tables. System tables such as "user" don't exist there, so a query that names
 * one fails as an unknown table. This is an allowlist, which no way of writing
 * the SQL can get around, unlike searching the text for bad table names.
 */
export function inspectViewQuery(rawQuery: string, schema: string[]) {
  const query = rawQuery.trim().replace(/;\s*$/, "");
  if (!query) throw refuse("Enter a SELECT statement.");
  if (query.length > MAX_VIEW_QUERY) throw refuse(`Must be at most ${MAX_VIEW_QUERY} characters.`);
  if (!/^(select|with)\b/i.test(query)) throw refuse("Must start with SELECT or WITH.");
  if (FORBIDDEN.test(query)) throw refuse("This query uses a SQLite internal that views can't access.");

  const scratch = new Database(":memory:");
  try {
    for (const statement of schema) scratch.exec(statement);
    let columns;
    try {
      const prepared = scratch.prepare(query);
      if (!prepared.reader || !prepared.readonly) throw refuse("Must be a read-only SELECT.");
      columns = prepared.columns();
      const names = columns.map((column) => column.name);
      const wrapped = createViewSql("__scratch_view", query, names);
      scratch.exec(wrapped);
      scratch.prepare(`SELECT * FROM "__scratch_view" LIMIT 0`).all();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw refuse((error as Error).message.slice(0, 300));
    }

    return { query, columns: checkViewColumns(columns.map((column) => ({ name: column.name, table: column.table, column: column.column }))) };
  } finally {
    scratch.close();
  }
}
