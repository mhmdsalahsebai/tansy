import "server-only";
import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import pg from "pg";
import { registerRuleFunctions } from "../authz/rules/sql";
import { scopePlugin } from "../scope/plugin";
import { BUSY_TIMEOUT_MS, databasePath } from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";

type Tables = Record<string, Record<string, unknown>>;

function open() {
  const database = new Database(databasePath(), { timeout: BUSY_TIMEOUT_MS });
  // Lets requests read while another connection writes. Stored in the file, so Prisma's connection gets it too.
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  registerRuleFunctions(database);
  return database;
}

const OID = { int8: 20, json: 114, date: 1082, numeric: 1700, timestamp: 1114, timestamptz: 1184, jsonb: 3802 };

const iso = (value: unknown) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value);

/** Rows read the same on both databases: numbers, ISO timestamps in UTC, and JSON as text for decodeColumn. */
const getTypeParser = ((oid: number, format?: "text" | "binary") => {
  const timestamptz = pg.types.getTypeParser(OID.timestamptz) as (value: string) => unknown;
  switch (oid) {
    case OID.int8:
    case OID.numeric: return Number;
    // The default turns a date into a local-time Date, which shifts it by the server's zone.
    case OID.date:
    case OID.json:
    case OID.jsonb: return (value: string) => value;
    case OID.timestamptz: return (value: string) => iso(timestamptz(value));
    // Prisma's columns have no zone and always hold UTC.
    case OID.timestamp: return (value: string) => iso(timestamptz(`${value}+00`));
    default: return pg.types.getTypeParser(oid, format as "text");
  }
}) as typeof pg.types.getTypeParser;

let pool: pg.Pool | undefined;

/** For the few things Kysely doesn't expose, such as a result's column origins. */
export function postgresPool() {
  return (pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_SIZE) || 10, types: { getTypeParser } }));
}

function create() {
  // Every record query passes through row scopes (core/scope/plugin.ts).
  const plugins = [scopePlugin];
  if (isPostgres()) return new Kysely<Tables>({ dialect: new PostgresDialect({ pool: async () => postgresPool() }), plugins });
  // A function, so importing this module never creates a database file.
  return new Kysely<Tables>({ dialect: new SqliteDialect({ database: async () => open() }), plugins });
}

declare const globalThis: { recordsDb?: ReturnType<typeof create> } & typeof global;

/** Record tables only. System tables stay with Prisma. */
export const recordsDb = globalThis.recordsDb ?? create();

if (process.env.NODE_ENV !== "production") globalThis.recordsDb = recordsDb;

/** Opens the connection at startup, so WAL is on before the first request. */
export const prepareRecordsDb = () => sql`SELECT 1`.execute(recordsDb);
