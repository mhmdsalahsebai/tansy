import "server-only";
import { parse } from "libpg-query";
import { postgresPool } from "../content/db";
import { HttpError } from "../http/errors";
import { viewSelectSql } from "./ddl";
import { checkViewColumns, MAX_VIEW_QUERY, type ViewColumn } from "./views";

const refuse = (message: string) => new HttpError(400, "INVALID_VIEW_QUERY", message, [{ path: "query", message }]);

/**
 * Functions a view may call. An allowlist because Postgres has many that reach
 * outside the record tables: query_to_xml runs arbitrary SQL, pg_read_file reads
 * the server's disk, and current_setting reads its configuration.
 */
export const VIEW_FUNCTIONS = new Set([
  "abs", "age", "array_agg", "array_length", "avg", "bool_and", "bool_or", "btrim", "ceil", "ceiling", "char_length", "character_length", "concat", "concat_ws",
  "count", "date_part", "date_trunc", "dense_rank", "extract", "first_value", "floor", "initcap", "json_agg", "json_build_object", "jsonb_agg", "jsonb_array_elements",
  "jsonb_array_elements_text", "jsonb_array_length", "jsonb_build_array", "jsonb_build_object", "jsonb_extract_path", "jsonb_extract_path_text", "jsonb_typeof", "lag", "last_value", "lead", "left",
  "length", "lower", "lpad", "ltrim", "make_date", "max", "min", "mod", "now", "ntile", "nullif", "overlay", "position", "power", "rank", "regexp_replace", "repeat",
  "replace", "reverse", "right", "round", "row_number", "rpad", "rtrim", "sign", "split_part", "sqrt", "string_agg", "strpos", "substr", "substring", "sum", "timezone", "to_char", "to_date",
  "to_jsonb", "to_number", "to_timestamp", "trim", "trunc", "upper",
]);

/** Node types that read outside the query, take parameters, or change how rows are locked or stored. */
const FORBIDDEN_NODES = new Set(["IntoClause", "LockingClause", "ParamRef", "RangeTableFunc", "RangeTableSample", "XmlExpr", "XmlSerialize"]);

const ALLOWED_VALUE_FUNCTIONS = /^SVFOP_(CURRENT_DATE|CURRENT_TIME(_N)?|CURRENT_TIMESTAMP(_N)?|LOCALTIME(_N)?|LOCALTIMESTAMP(_N)?)$/;

type Node = Record<string, unknown>;
const names = (list: unknown) => (list as Array<{ String?: { sval: string } }>).map((item) => item.String?.sval ?? "");

/** Applies the allowlists to the tree from Postgres's own parser, so a trick of quoting or comments can't reach a table or function unseen. */
function assertAllowed(node: unknown, tables: ReadonlySet<string>, cteNames: ReadonlySet<string>) {
  if (Array.isArray(node)) {
    for (const item of node) assertAllowed(item, tables, cteNames);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Node)) {
    if (FORBIDDEN_NODES.has(key)) throw refuse("This query uses a feature views can't use.");
    if (key === "intoClause" || key === "lockingClause") throw refuse("Must be a read-only SELECT.");
    const body = value as Node;
    if (key === "RangeVar") {
      if (body.schemaname || body.catalogname) throw refuse("Name record tables without a schema.");
      const relation = body.relname as string;
      if (!tables.has(relation) && !cteNames.has(relation)) throw refuse(`relation "${relation.slice(0, 63)}" is not a record table.`);
    }
    if (key === "FuncCall") {
      const name = names(body.funcname);
      const unqualified = name.length === 1 || (name.length === 2 && name[0] === "pg_catalog");
      if (!unqualified || !VIEW_FUNCTIONS.has(name[name.length - 1])) throw refuse(`Function "${name.join(".").slice(0, 63)}" can't be used in a view.`);
    }
    if (key === "SQLValueFunction" && !ALLOWED_VALUE_FUNCTIONS.test(body.op as string)) throw refuse("This value can't be used in a view.");
    if (key === "TypeCast") {
      const type = names((body.typeName as Node).names);
      if (type[type.length - 1].startsWith("reg")) throw refuse("This type can't be used in a view.");
    }
    if (key === "A_Expr" && Array.isArray(body.name) && body.name.length > 1) throw refuse("Operators can't name a schema in a view.");
    assertAllowed(value, tables, cteNames);
  }
}

function* cteNamesIn(node: unknown): Generator<string> {
  if (Array.isArray(node)) {
    for (const item of node) yield* cteNamesIn(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Node)) {
    if (key === "CommonTableExpr") yield (value as Node).ctename as string;
    yield* cteNamesIn(value);
  }
}

/**
 * Checks a view's SQL. Postgres has no equivalent of SQLite's empty in-memory
 * database, so the query is parsed by Postgres's parser and every relation and
 * function in it must be on an allowlist. It's then planned, without running, in
 * a read-only transaction, which also reports where each column comes from.
 */
export async function inspectPostgresViewQuery(rawQuery: string, recordTables: string[]): Promise<{ query: string; columns: ViewColumn[] }> {
  const query = rawQuery.trim().replace(/;\s*$/, "");
  if (!query) throw refuse("Enter a SELECT statement.");
  if (query.length > MAX_VIEW_QUERY) throw refuse(`Must be at most ${MAX_VIEW_QUERY} characters.`);
  if (!/^(select|with)\b/i.test(query)) throw refuse("Must start with SELECT or WITH.");

  let tree: { stmts: Array<{ stmt: Node }> };
  try {
    tree = (await parse(query)) as unknown as typeof tree;
  } catch (error) {
    throw refuse((error as Error).message.slice(0, 300));
  }
  if (tree.stmts.length !== 1 || !tree.stmts[0].stmt.SelectStmt) throw refuse("Must be a single read-only SELECT.");

  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 5000");

    // A CTE named like a real table could read it from a scope where the CTE isn't visible, so such names are refused outright.
    const cteNames = new Set(cteNamesIn(tree.stmts[0].stmt));
    if (cteNames.size) {
      const { rows } = await client.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relname = ANY($1)", [[...cteNames]]);
      if (rows.length) throw refuse(`"${rows[0].relname.slice(0, 63)}" is already a table name. Give the WITH clause another name.`);
    }
    assertAllowed(tree.stmts[0].stmt, new Set(recordTables), cteNames);

    let fields;
    try {
      ({ fields } = await client.query(`SELECT * FROM (${query}\n) q LIMIT 0`));
      await client.query(`${viewSelectSql(query, fields.map((field) => field.name))} LIMIT 0`);
    } catch (error) {
      throw refuse((error as Error).message.slice(0, 300));
    }

    const origins = await client.query<{ attrelid: number; attnum: number; relname: string; attname: string }>(
      "SELECT a.attrelid, a.attnum, c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attrelid = ANY($1)",
      [[...new Set(fields.map((field) => field.tableID).filter(Boolean))]],
    );
    const origin = new Map(origins.rows.map((row) => [`${row.attrelid}:${row.attnum}`, row]));
    const columns = fields.map((field): ViewColumn => {
      const source = origin.get(`${field.tableID}:${field.columnID}`);
      return { name: field.name, table: source?.relname ?? null, column: source?.attname ?? null };
    });
    return { query, columns: checkViewColumns(columns) };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
