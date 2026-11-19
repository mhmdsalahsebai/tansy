import "server-only";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";

/** Atomic fixed-window counter. Returns true when the request is within the limit. */
export async function consumeRateLimit(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const now = new Date().toISOString();
  const windowOpened = new Date(Date.now() - windowSeconds * 1000).toISOString();
  // SQLite stores these as ISO text. Postgres has to be told a bound string is a timestamp.
  const rows = isPostgres()
    ? await prisma.$queryRaw<Array<{ count: number | bigint }>>`
    INSERT INTO "GuardRateLimit" ("key", "count", "windowStart") VALUES (${key}, 1, ${now}::timestamp)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "GuardRateLimit"."windowStart" < ${windowOpened}::timestamp THEN 1 ELSE "GuardRateLimit"."count" + 1 END,
      "windowStart" = CASE WHEN "GuardRateLimit"."windowStart" < ${windowOpened}::timestamp THEN ${now}::timestamp ELSE "GuardRateLimit"."windowStart" END
    RETURNING "count"`
    : await prisma.$queryRaw<Array<{ count: number | bigint }>>`
    INSERT INTO "GuardRateLimit" ("key", "count", "windowStart") VALUES (${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "GuardRateLimit"."windowStart" < ${windowOpened} THEN 1 ELSE "GuardRateLimit"."count" + 1 END,
      "windowStart" = CASE WHEN "GuardRateLimit"."windowStart" < ${windowOpened} THEN ${now} ELSE "GuardRateLimit"."windowStart" END
    RETURNING "count"`;
  return Number(rows[0].count) <= max;
}
