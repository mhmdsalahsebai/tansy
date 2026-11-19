import "server-only";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import pg from "pg";

/**
 * The two databases are copied in very different ways, and each way is that
 * database's own recommended one:
 *
 * - SQLite: `VACUUM INTO` writes a consistent, compacted copy from one read
 *   transaction, while the server keeps reading and writing (WAL). Restoring uses
 *   SQLite's backup API, which writes through the live file's own journal, so a
 *   stale `-wal` file can never be replayed over the restored pages.
 * - Postgres: `pg_dump` in custom format from a snapshot exported by our own
 *   transaction, so the file list read in that transaction matches the dump
 *   exactly. Restoring drops and rebuilds the `public` schema through `psql` in a
 *   single transaction, so a failed restore leaves the database as it was.
 */

export type BackupDatabase = { kind: "sqlite"; file: string } | { kind: "postgres"; url: string };

export function databaseFromUrl(url = process.env.DATABASE_URL ?? ""): BackupDatabase {
  if (!url) throw new Error("Set DATABASE_URL.");
  if (/^postgres(ql)?:\/\//i.test(url)) return { kind: "postgres", url };
  // Resolved here, so the CLI and the server open the same file whichever folder they start in.
  return { kind: "sqlite", file: path.resolve(url.replace(/^file:/, "")) };
}

export interface SnapshotFile {
  id: string;
  storage: string;
  key: string;
  size: number;
  type: string;
}

export interface Snapshot {
  /** The copy of the database, in the temporary folder. */
  file: string;
  migrations: string[];
  files: SnapshotFile[];
}

const MIGRATIONS_SQL = `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
const FILES_SQL = `SELECT id, storage, key, size, type FROM "StoredFile" ORDER BY id`;

const toFile = (row: Record<string, unknown>): SnapshotFile => ({ id: String(row.id), storage: String(row.storage), key: String(row.key), size: Number(row.size), type: String(row.type) });

// ---------------------------------------------------------------- SQLite

/** Runs off the main thread, so a large database doesn't stall requests while it's copied and checked. */
const SNAPSHOT_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const Database = require(workerData.driver);
const source = new Database(workerData.source, { readonly: true, fileMustExist: true, timeout: workerData.timeout });
try { source.prepare("VACUUM INTO ?").run(workerData.target); } finally { source.close(); }
const copy = new Database(workerData.target, { readonly: true });
try { parentPort.postMessage(copy.pragma("quick_check", { simple: true })); } finally { copy.close(); }
`;

function driverPath() {
  for (const base of [path.join(process.cwd(), "package.json"), import.meta.url]) {
    try {
      return createRequire(base).resolve("better-sqlite3");
    } catch {
      // Tried next.
    }
  }
  return null;
}

function snapshotInThread(source: string, target: string) {
  const copy = new Database(source, { readonly: true, fileMustExist: true, timeout: 10_000 });
  try {
    copy.prepare("VACUUM INTO ?").run(target);
  } finally {
    copy.close();
  }
  const check = new Database(target, { readonly: true });
  try {
    return String(check.pragma("quick_check", { simple: true }));
  } finally {
    check.close();
  }
}

async function snapshotSqlite(file: string, target: string): Promise<string> {
  const driver = driverPath();
  if (driver) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const worker = new Worker(SNAPSHOT_WORKER, { eval: true, workerData: { driver, source: file, target, timeout: 10_000 } });
        worker.once("message", (result) => resolve(String(result)));
        worker.once("error", reject);
        worker.once("exit", (code) => code && reject(new Error(`The snapshot worker stopped with code ${code}.`)));
      });
    } catch (error) {
      // A bundler can hide the driver from a worker. Copying on this thread is slower for requests, never less correct.
      if (!/Cannot find module|MODULE_NOT_FOUND|ERR_DLOPEN/.test(String((error as Error).message))) throw error;
    }
  }
  return snapshotInThread(file, target);
}

function readSqliteSnapshot(file: string) {
  const copy = new Database(file, { readonly: true });
  try {
    return {
      migrations: (copy.prepare(MIGRATIONS_SQL).all() as Array<{ migration_name: string }>).map((row) => row.migration_name),
      files: (copy.prepare(FILES_SQL).all() as Array<Record<string, unknown>>).map(toFile),
    };
  } finally {
    copy.close();
  }
}

// ---------------------------------------------------------------- Postgres

/** libpq refuses parameters it doesn't know, which Prisma and node-postgres accept. */
const LIBPQ_PARAMETERS = new Set([
  "host", "hostaddr", "port", "dbname", "user", "passfile", "channel_binding", "connect_timeout", "client_encoding", "options",
  "application_name", "fallback_application_name", "keepalives", "keepalives_idle", "keepalives_interval", "keepalives_count",
  "tcp_user_timeout", "sslmode", "requiressl", "sslnegotiation", "sslcompression", "sslcert", "sslkey", "sslpassword",
  "sslcertmode", "sslrootcert", "sslcrl", "sslcrldir", "sslsni", "requirepeer", "ssl_min_protocol_version",
  "ssl_max_protocol_version", "gssencmode", "krbsrvname", "gsslib", "gssdelegation", "service", "target_session_attrs", "load_balance_hosts",
]);

/**
 * The password goes in the environment, never on the command line, where any
 * account on the machine could read it from the process list.
 */
export function libpqConnection(url: string) {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  for (const name of [...parsed.searchParams.keys()]) if (!LIBPQ_PARAMETERS.has(name)) parsed.searchParams.delete(name);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("PG")) delete env[name];
  if (password) env.PGPASSWORD = password;
  return { dbname: parsed.toString(), env };
}

/** TANSY_PG_BIN points at a folder of client tools matching the server's major version. */
const pgTool = (name: string) => (process.env.TANSY_PG_BIN ? path.join(process.env.TANSY_PG_BIN, name) : name);

interface Run {
  code: number | null;
  stderr: string;
}

function collect(child: ReturnType<typeof spawn>, tool: string) {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8000);
  });
  return new Promise<Run>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT"
        ? new Error(`${tool} was not found. Install the PostgreSQL client tools for your server's major version, or set TANSY_PG_BIN to their folder.`)
        : error);
    });
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

const toolFailed = (tool: string, { code, stderr }: Run) => new Error(`${tool} failed (exit ${code}): ${stderr.trim().split("\n").slice(-5).join(" ") || "no output"}`);

async function snapshotPostgres(url: string, target: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Kept open until pg_dump has finished, because an exported snapshot only lives as long as its transaction.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [{ snapshot }] } = await client.query<{ snapshot: string }>("SELECT pg_export_snapshot() AS snapshot");
    const migrations = (await client.query<{ migration_name: string }>(MIGRATIONS_SQL)).rows.map((row) => row.migration_name);
    const files = (await client.query(FILES_SQL)).rows.map(toFile);
    const { dbname, env } = libpqConnection(url);
    const dump = spawn(pgTool("pg_dump"), ["--format=custom", "--schema=public", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`, "--file", target, "--dbname", dbname], { env, stdio: ["ignore", "ignore", "pipe"] });
    const result = await collect(dump, "pg_dump");
    if (result.code !== 0) throw toolFailed("pg_dump", result);
    await client.query("COMMIT");
    return { migrations, files };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Reads the dump's table of contents, which fails on a damaged or foreign file. */
export async function checkPostgresDump(file: string) {
  const result = await collect(spawn(pgTool("pg_restore"), ["--list", file], { stdio: ["ignore", "ignore", "pipe"] }), "pg_restore");
  if (result.code !== 0) throw toolFailed("pg_restore", result);
}

// ---------------------------------------------------------------- Both

export async function snapshotDatabase(database: BackupDatabase, directory: string): Promise<Snapshot> {
  if (database.kind === "sqlite") {
    const file = path.join(directory, "database.sqlite");
    const check = await snapshotSqlite(database.file, file);
    if (check !== "ok") throw new Error(`The database copy failed its integrity check: ${check}`);
    return { file, ...readSqliteSnapshot(file) };
  }
  const file = path.join(directory, "database.pgdump");
  const read = await snapshotPostgres(database.url, file);
  await checkPostgresDump(file);
  return { file, ...read };
}

export function checkSqliteCopy(file: string) {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = String(copy.pragma("integrity_check", { simple: true }));
    if (result !== "ok") throw new Error(`The database in the archive failed its integrity check: ${result}`);
  } finally {
    copy.close();
  }
}

/** Connections other than this one. A running server holds some, and a restore under it would leave it serving stale state. */
export async function otherPostgresConnections(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [{ count }] } = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'",
    );
    return Number(count);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function restoreDatabase(database: BackupDatabase, copy: string) {
  if (database.kind === "sqlite") {
    checkSqliteCopy(copy);
    await mkdir(path.dirname(database.file), { recursive: true });
    const source = new Database(copy, { readonly: true });
    try {
      await source.backup(database.file);
    } finally {
      source.close();
    }
    return;
  }
  const { dbname, env } = libpqConnection(database.url);
  const restore = spawn(pgTool("pg_restore"), ["--no-owner", "--no-privileges", "--file", "-", copy], { env, stdio: ["ignore", "pipe", "pipe"] });
  const psql = spawn(pgTool("psql"), ["--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--file", "-", "--dbname", dbname], { env, stdio: ["pipe", "ignore", "pipe"] });
  const input = psql.stdin!;
  // psql stopping early would otherwise surface as an unhandled EPIPE.
  input.on("error", () => {});
  const applied = collect(psql, "psql");
  // One transaction, committed only once pg_restore has written the whole dump. psql's own
  // --single-transaction would commit whatever arrived if pg_restore died partway, schema drop included.
  // Without the COMMIT, psql's connection closes and Postgres rolls everything back.
  input.write("BEGIN;\nSET client_min_messages = warning;\nDROP SCHEMA IF EXISTS public CASCADE;\n");
  restore.stdout!.pipe(input, { end: false });
  const restored = await collect(restore, "pg_restore");
  if (restored.code === 0) input.end("\nCOMMIT;\n");
  else psql.kill();
  const result = await applied;
  if (restored.code !== 0) throw toolFailed("pg_restore", restored);
  if (result.code !== 0) throw toolFailed("psql", result);
}

export interface SqlConnection {
  json(value: unknown): string;
  query(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

/** A few statements against whichever database DATABASE_URL names, with $1-style placeholders. */
export async function openSql(database: BackupDatabase): Promise<SqlConnection> {
  if (database.kind === "postgres") {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    return {
      json: (value: unknown) => JSON.stringify(value),
      query: async (text: string, params: unknown[] = []) => (await client.query(text, params)).rows as Array<Record<string, unknown>>,
      close: () => client.end(),
    };
  }
  const db = new Database(database.file, { fileMustExist: true, timeout: 10_000 });
  return {
    json: (value: unknown) => JSON.stringify(value),
    query: async (text: string, params: unknown[] = []) => {
      const statement = db.prepare(text.replace(/\$\d+/g, "?"));
      return statement.reader ? (statement.all(...params) as Array<Record<string, unknown>>) : (statement.run(...params), []);
    },
    close: async () => void db.close(),
  };
}
