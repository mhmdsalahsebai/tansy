import "server-only";
import { audit } from "../audit";
import { getCmsConfig } from "../config";
import type { Registered } from "../extend/registry";
import type { JobDefinition } from "../extend/define";
import { assertBackupsUsable, encryptionKeyFor, keepOf, type BackupConfig } from "./config";
import { createBackup, pruneBackups, sendBackup } from "./service";

/** Stored in JobRun under this name, with the outcome of its last run. */
export const BACKUP_JOB = "cms.backup";

/** Next.js only logs an error thrown during startup and carries on serving, so refusing has to end the process. */
export function exitIfBackupsUnusable() {
  try {
    assertBackupsUsable(getCmsConfig().backups);
  } catch (error) {
    console.error(`[backup] refusing to start: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * One backup, sent and pruned, with an audit entry either way. A failure is
 * thrown again so the job's last run shows it, and `onAudit` forwards it to
 * whatever watches the audit log.
 */
export async function runBackup(config: BackupConfig) {
  const started = Date.now();
  let name: string | null = null;
  try {
    const backup = await createBackup({ storage: getCmsConfig().storage, files: config.files !== false, key: encryptionKeyFor(config) });
    name = backup.name;
    try {
      await sendBackup(config.adapter, backup);
    } finally {
      await backup.cleanup();
    }
    const removed = await pruneBackups(config.adapter, keepOf(config), backup.name);
    const { manifest } = backup;
    if (manifest.missingFiles.length) console.warn(`[backup] ${backup.name} is missing ${manifest.missingFiles.length} files that storage couldn't supply.`);
    await audit({
      action: "backup.create",
      outcome: "success",
      actorKind: "system",
      targetType: "backup",
      targetId: backup.name,
      metadata: { bytes: backup.bytes, files: manifest.files.length, missingFiles: manifest.missingFiles.length, encrypted: backup.name.endsWith(".enc"), pruned: removed.length, durationMs: Date.now() - started },
    });
    return backup.name;
  } catch (error) {
    await audit({ action: "backup.create", outcome: "failure", actorKind: "system", targetType: "backup", targetId: name ?? undefined, metadata: { error: (error as Error).message.slice(0, 300) } });
    throw error;
  }
}

/** The scheduled backup, when tansy.config.ts sets `backups.schedule`. */
export function backupJobs(): Array<Registered<JobDefinition>> {
  const config = getCmsConfig().backups;
  if (!config?.schedule) return [];
  return [{ source: "system", value: { name: BACKUP_JOB, cron: config.schedule, handler: async () => void (await runBackup(config)) } }];
}
