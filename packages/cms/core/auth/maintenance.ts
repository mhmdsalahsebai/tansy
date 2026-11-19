import "server-only";
import { purgeAuditLog } from "../audit";
import { purgeUnattachedUploads } from "../files/cleanup";
import { purgeExpiredTrash } from "../content/trash";
import prisma from "../../lib/prisma";
import { loadAuthSettings } from "./settings";

const DAY_MS = 86_400_000;

export async function runAuthMaintenance() {
  const { settings } = await loadAuthSettings();
  await purgeAuditLog(settings.audit.retentionDays);
  await purgeUnattachedUploads(settings.files.unattachedRetentionDays);
  await purgeExpiredTrash();
  const cutoff = new Date(Date.now() - DAY_MS);
  await prisma.guardRateLimit.deleteMany({ where: { windowStart: { lt: cutoff } } });
  await prisma.loginThrottle.deleteMany({ where: { lastFailureAt: { lt: cutoff }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] } });
}
