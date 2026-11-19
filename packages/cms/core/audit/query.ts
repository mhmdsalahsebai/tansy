import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";
import { currentScopeValue } from "../scope/context";

/** LIKE ignores case on SQLite, and Postgres needs asking. */
const containing = (value: string) => ({ contains: value, ...(isPostgres() ? { mode: "insensitive" as const } : {}) }) as Prisma.StringFilter;

export async function listAudit(q: { page: number; perPage: number; action?: string; actor?: string; outcome?: string }) {
  // Within a scope value, only that value's events. Outside one, every event, as before.
  const scope = currentScopeValue();
  const where: Prisma.AuditLogWhereInput = {
    ...(scope !== null ? { scope } : {}),
    ...(q.action ? { action: containing(q.action) } : {}),
    ...(q.actor ? { actorEmail: containing(q.actor) } : {}),
    ...(q.outcome ? { outcome: q.outcome } : {}),
  };
  const [totalItems, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { at: "desc" }, skip: (q.page - 1) * q.perPage, take: q.perPage }),
  ]);
  return { page: q.page, perPage: q.perPage, totalItems, items };
}
