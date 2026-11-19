import "server-only";
import { createHash } from "node:crypto";
import prisma from "../../lib/prisma";
import type { AuthSettings } from "./settings-schema";

const identifierFor = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** Delay doubles per failure past the threshold, capped: OWASP's exponential lockout. */
export function lockDelaySeconds(failures: number, lockout: AuthSettings["lockout"]): number {
  const over = failures - lockout.maxFailures;
  if (over < 0) return 0;
  return Math.min(lockout.baseDelaySeconds * 2 ** Math.min(over, 20), lockout.maxDelaySeconds);
}

export async function isLocked(email: string): Promise<boolean> {
  const row = await prisma.loginThrottle.findUnique({ where: { identifier: identifierFor(email) } });
  return Boolean(row?.lockedUntil && row.lockedUntil > new Date());
}

export async function recordFailure(email: string, settings: AuthSettings["lockout"]) {
  const identifier = identifierFor(email);
  const row = await prisma.loginThrottle.upsert({
    where: { identifier },
    create: { identifier, failures: 1 },
    update: { failures: { increment: 1 }, lastFailureAt: new Date() },
  });
  const delay = lockDelaySeconds(row.failures, settings);
  if (delay > 0) {
    await prisma.loginThrottle.update({
      where: { identifier },
      data: { lockedUntil: new Date(Date.now() + delay * 1000) },
    });
  }
  return { failures: row.failures, locked: delay > 0 };
}

export async function clearFailures(email: string) {
  await prisma.loginThrottle.deleteMany({ where: { identifier: identifierFor(email) } });
}
