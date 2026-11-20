import "server-only";
import { Prisma } from "../../generated/client-sqlite";
import { sql, type Transaction } from "kysely";
import { isPostgres } from "../../lib/prisma/kind";

type Trx = Transaction<Record<string, Record<string, unknown>>>;

/**
 * Makes later reads in this transaction safe from other writers holding the same
 * key. SQLite has one writer, so any write takes the lock for everything. Postgres
 * runs writers side by side, so it needs a named lock, released at commit.
 */
export async function serializeRecordWrites(trx: Trx, key: string) {
  if (isPostgres()) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
  else await sql`UPDATE "Collection" SET "updatedAt" = "updatedAt" WHERE FALSE`.execute(trx);
}

export async function serializeWrites(tx: Prisma.TransactionClient, key: string) {
  if (isPostgres()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  else await tx.$executeRaw`UPDATE "Collection" SET "updatedAt" = "updatedAt" WHERE FALSE`;
}

const queued = new Map<string, Promise<unknown>>();

/**
 * Runs `work` while no other server runs it, for setup that every server repeats at startup
 * but that must happen once: several cold starts at the same moment would each create the same
 * collections and blocks. Held in a transaction on a connection of its own, because a pooler in
 * transaction mode (Neon, PgBouncer) can't keep a session-level lock. The work itself uses other
 * connections. SQLite has one writer and, in practice, one server, so there it only queues behind
 * the same work in this process.
 */
export async function onlyOneServer<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (!isPostgres()) {
    const before = queued.get(key) ?? Promise.resolve();
    const run = before.then(work, work);
    queued.set(key, run.catch(() => undefined));
    return run;
  }
  const { postgresPool } = await import("./db");
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    try {
      return await work();
    } finally {
      await client.query("COMMIT").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export const LOCK = {
  /** Startup's one-time setup: blocks, field upgrades, plugin migrations and theme seeds. */
  startup: "cms:startup",
  /** Every change to collections, fields and views. Rules and views can depend on other collections, so one lock covers them all. */
  schema: "cms:schema",
  /** User field definitions and everyone's values, which removing a field rewrites. */
  userFields: "cms:user-fields",
  /** All redirects, because a loop can run through any of them. */
  redirects: "cms:redirects",
} as const;

/** The row can't be changed or deleted until commit. No-op on SQLite, where the write lock already covers it. */
export const forUpdate = <Q extends { forUpdate(): Q }>(query: Q) => (isPostgres() ? query.forUpdate() : query);

/** The row can't be deleted until commit, though it can still be edited. */
export const forKeyShare = <Q extends { forKeyShare(): Q }>(query: Q) => (isPostgres() ? query.forKeyShare() : query);
