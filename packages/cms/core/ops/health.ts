import "server-only";
import prisma from "../../lib/prisma";
import { assertStorageUsable } from "../storage";

/**
 * Whether this server is alive, and whether it can serve. Two answers, because a load
 * balancer uses them differently: a server that fails liveness is restarted, one that fails
 * readiness is only taken out of rotation until it recovers.
 *
 * Neither says anything a stranger could use: no version, no host, no error text. What failed
 * is in the server's own log, and the numbers are in `/api/metrics`, which needs a permission.
 */

/** Reads nothing, so a server whose database is down still answers it and isn't restarted for that. */
export const liveness = () => ({ status: "ok" as const, uptimeSeconds: Math.round(process.uptime()) });

/** A check that hangs is a check that failed: a readiness probe has to answer quickly. */
const CHECK_TIMEOUT_MS = 2_000;

function within<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The check timed out.")), CHECK_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export interface Readiness {
  ready: boolean;
  /** One boolean each, never a reason: those go to the log, not to an anonymous caller. */
  checks: { database: boolean; storage: boolean };
}

/**
 * The two things every request needs: the database answers, and the storage adapter may run
 * here. Nothing else is checked, so a server still starting up its own background work, or
 * one waiting for first-run setup, is ready: it can already serve and be set up.
 */
export async function readiness(): Promise<Readiness> {
  const [database, storage] = await Promise.all([
    within(prisma.$queryRaw`SELECT 1`).then(
      () => true,
      (error: unknown) => {
        console.error("[health] the database did not answer", error);
        return false;
      },
    ),
    (async () => {
      try {
        assertStorageUsable();
        return true;
      } catch (error) {
        console.error("[health] storage can't be used here", error);
        return false;
      }
    })(),
  ]);
  return { ready: database && storage, checks: { database, storage } };
}
