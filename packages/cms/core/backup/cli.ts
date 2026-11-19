import "server-only";
import { copyFile, readdir, rename, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { CmsConfig } from "../auth/extensions";
import { assertBackupsUsable, encryptionKeyFor, keepOf } from "./config";
import { assertBackupKey, backupKey } from "./crypto";
import { databaseFromUrl, otherPostgresConnections } from "./database";
import {
  backupName, createBackup, databaseHasData, downloadBackup, finishRestore, listBackups, openBackup, pruneBackups,
  recordBackupAudit, restoreDatabaseFrom, restoreFiles, restoreProblems, sendBackup, verifyBackup, type FilePlacement, type OpenedBackup,
} from "./service";

/** What `tansy backup` and `tansy restore` run. The CLI loads this file directly, so nothing here may need Next.js or Prisma. */

const log = (line: string) => console.log(line);

export function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

/** A key that is set must be usable, even when nothing requires one. */
function optionalKey() {
  const key = backupKey();
  if (key) assertBackupKey(key);
  return key;
}

async function moveInto(from: string, to: string) {
  try {
    await rename(from, to);
  } catch {
    // A temporary folder is often on another disk.
    await copyFile(from, to);
  }
}

export interface BackupCommandOptions {
  /** A file or folder to write the archive to, instead of backups.adapter. */
  out?: string;
  /** false leaves uploads out. Defaults to the config's `files`. */
  files?: boolean;
}

export async function backupCommand(config: CmsConfig, { out, files }: BackupCommandOptions) {
  const backups = config.backups;
  if (!out && !backups) throw new Error("Set backups in tansy.config.ts, or pass --out <file or folder>.");
  if (!out) assertBackupsUsable(backups);
  const key = backups ? encryptionKeyFor(backups) : optionalKey();
  const database = databaseFromUrl();
  let name: string | undefined;
  try {
    const backup = await createBackup({ database, storage: config.storage, files: files ?? backups?.files !== false, key, log });
    name = backup.name;
    let where: string;
    try {
      if (out) {
        const target = existsSync(out) && statSync(out).isDirectory() ? path.join(out, backup.name) : path.resolve(out);
        if (existsSync(target)) throw new Error(`${target} already exists.`);
        await moveInto(backup.path, target);
        where = target;
      } else {
        await sendBackup(backups!.adapter, backup);
        where = `${backup.name} in storage "${backups!.adapter.name}"`;
      }
    } finally {
      await backup.cleanup();
    }
    const { manifest } = backup;
    log(`Wrote ${where} (${formatBytes(backup.bytes)}, ${manifest.files.length} files${key ? ", encrypted" : ""}).`);
    if (!key) log("It isn't encrypted, and it holds every password hash and session. Set TANSY_BACKUP_KEY to encrypt backups.");
    for (const file of manifest.missingFiles.slice(0, 10)) log(`  missing: ${file.id} (${file.reason})`);
    if (manifest.missingFiles.length > 10) log(`  …and ${manifest.missingFiles.length - 10} more missing files.`);
    if (!out) {
      const removed = await pruneBackups(backups!.adapter, keepOf(backups!), backup.name);
      if (removed.length) log(`Removed ${removed.length} older ${removed.length === 1 ? "backup" : "backups"}, keeping ${keepOf(backups!)}.`);
    }
    await recordBackupAudit(database, "success", backup.name, { via: "cli", bytes: backup.bytes, files: manifest.files.length, missingFiles: manifest.missingFiles.length, encrypted: Boolean(key) })
      .catch((error) => log(`Could not write the audit entry: ${(error as Error).message}`));
  } catch (error) {
    await recordBackupAudit(database, "failure", name ?? "", { via: "cli", error: (error as Error).message.slice(0, 300) }).catch(() => {});
    throw error;
  }
}

export async function listCommand(config: CmsConfig) {
  if (!config.backups) throw new Error("Set backups in tansy.config.ts to list its backups.");
  const backups = await listBackups(config.backups.adapter);
  if (!backups.length) return log(`No backups in storage "${config.backups.adapter.name}".`);
  for (const backup of backups) log(`${backup.name}  ${formatBytes(backup.size).padStart(10)}  ${backup.createdAt.toISOString()}${backup.encrypted ? "  encrypted" : ""}`);
}

/** A local file, a backup's name in backups.adapter, or "latest". */
async function fetchSource(config: CmsConfig, source: string | undefined) {
  if (source && existsSync(source)) return { file: path.resolve(source), label: path.basename(source), cleanup: async () => {} };
  if (!config.backups) throw new Error(source ? `${source} is not a file, and tansy.config.ts sets no backups to look in.` : "Name a backup file, or set backups in tansy.config.ts.");
  let name = source;
  if (!name || name === "latest") {
    const [latest] = await listBackups(config.backups.adapter);
    if (!latest) throw new Error(`There are no backups in storage "${config.backups.adapter.name}".`);
    name = latest.name;
  }
  log(`Downloading ${name}.`);
  const downloaded = await downloadBackup(config.backups.adapter, name);
  return { file: downloaded.path, label: name, cleanup: downloaded.cleanup };
}

function describe(backup: OpenedBackup) {
  const { manifest } = backup;
  return `${manifest.database.kind} database from ${manifest.createdAt}, tansy ${manifest.cmsVersion}, ${manifest.files.length} files${backup.encrypted ? ", encrypted" : ""}`;
}

async function opened<T>(config: CmsConfig, source: string | undefined, work: (backup: OpenedBackup, label: string) => Promise<T>) {
  const fetched = await fetchSource(config, source);
  try {
    const backup = await openBackup(fetched.file, backupKey());
    try {
      return await work(backup, fetched.label);
    } finally {
      await backup.cleanup();
    }
  } finally {
    await fetched.cleanup();
  }
}

export async function verifyCommand(config: CmsConfig, source: string | undefined) {
  await opened(config, source, async (backup, label) => {
    log(`${label}: ${describe(backup)}.`);
    await verifyBackup(backup);
    log("Every checksum matches, and the database copy reads cleanly.");
    if (backup.manifest.missingFiles.length) log(`${backup.manifest.missingFiles.length} files were already missing from storage when it was made.`);
  });
}

export interface RestoreCommandOptions {
  /** false restores the database only, leaving storage alone. */
  files: boolean;
  /** Skip the confirmation. */
  yes: boolean;
  /** Restore despite different secrets or other open connections. */
  force: boolean;
  /** Save the current database first. */
  safetyCopy: boolean;
  /** Where that copy goes. Defaults to the SQLite file's own folder, or the working folder for Postgres. */
  safetyDir?: string;
  /** The package's Prisma migration folders, to recognise a backup from a newer version. */
  migrationsDir: (kind: "sqlite" | "postgres") => string;
  /** Applies migrations, so an older backup matches this version. */
  migrate: () => void | Promise<void>;
  ask: (question: string) => Promise<string>;
}

export async function restoreCommand(config: CmsConfig, source: string | undefined, options: RestoreCommandOptions) {
  const database = databaseFromUrl();
  await opened(config, source, async (backup, label) => {
    log(`${label}: ${describe(backup)}.`);
    log("Checking the archive.");
    await verifyBackup(backup);

    const known = (await readdir(options.migrationsDir(database.kind), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const problems = restoreProblems(backup.manifest, database, known);
    const blocking = problems.filter((problem) => !problem.forceable || !options.force);
    for (const problem of problems) log(`${blocking.includes(problem) ? "Refused" : "Warning"}: ${problem.message}`);
    if (blocking.length) throw new Error("Nothing was changed.");

    if (database.kind === "postgres" && !options.force) {
      const others = await otherPostgresConnections(database.url);
      if (others) throw new Error(`${others} other connections are open to this database. Stop the server first, or pass --force if they aren't the CMS. Nothing was changed.`);
    }
    if (options.files && backup.manifest.files.length && !config.storage) throw new Error("tansy.config.ts sets no storage to put the files in. Pass --no-files to restore the database only.");

    const where = database.kind === "sqlite" ? database.file : new URL(database.url).pathname.slice(1);
    if (!options.yes) {
      log(`\nThis replaces the database ${where}${options.files ? " and puts the backup's files back in storage" : ""}.`);
      log("Stop the server first: one that keeps running would serve stale state, and on SQLite could write over the restore.");
      const answer = await options.ask('Type "restore" to continue: ');
      if (answer.trim() !== "restore") throw new Error("Nothing was changed.");
    }

    if (options.safetyCopy && (await databaseHasData(database))) {
      log("Saving the current database first.");
      const key = optionalKey();
      const current = await createBackup({ database, files: false, key });
      try {
        const folder = options.safetyDir ?? (database.kind === "sqlite" ? path.dirname(database.file) : process.cwd());
        const target = path.resolve(folder, backupName(new Date(), Boolean(key)).replace(/^cms-backup-/, "cms-before-restore-"));
        await moveInto(current.path, target);
        log(`  ${target} (${formatBytes((await stat(target)).size)})`);
      } finally {
        await current.cleanup();
      }
    }

    let placement: FilePlacement | null = null;
    if (options.files && backup.manifest.files.length) {
      log(`Putting back ${backup.manifest.files.length} files.`);
      placement = await restoreFiles(backup, config.storage!, log);
    }

    log("Restoring the database.");
    await restoreDatabaseFrom(backup, database);
    log("Applying migrations.");
    await options.migrate();
    await finishRestore(database, { name: label, placement });

    log(`\nRestored ${label}. Every session was ended, so everyone signs in again.`);
    log("Accounts, passwords and API keys are as they were when the backup was made: review any changed since. Start the server.");
    if (backup.manifest.missingFiles.length) log(`${backup.manifest.missingFiles.length} files were already missing when the backup was made, and are still missing.`);
  });
}
