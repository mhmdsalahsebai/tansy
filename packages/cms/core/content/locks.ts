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

export const LOCK = {
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
