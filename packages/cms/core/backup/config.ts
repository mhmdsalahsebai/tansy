import "server-only";
import { parseCron } from "../extend/cron";
import type { StorageAdapter } from "../storage/types";
import { assertBackupKey, backupKey } from "./crypto";

export interface BackupConfig {
  /**
   * Where archives go: any StorageAdapter that can `list`, such as
   * `s3Storage({ ..., prefix: "backups" })` or `localStorage({ dir: "/mnt/backups" })`.
   * Keep it apart from the server and its uploads, or one failure takes both.
   */
  adapter: StorageAdapter;
  /** When to back up, as five cron fields in UTC, such as "0 3 * * *". Without it, only `tansy backup` makes one. */
  schedule?: string;
  /** How many archives to keep. Older ones are deleted after each successful backup. Defaults to 7. */
  keep?: number;
  /** Copy uploaded files into each archive. Defaults to true. Thumbnails are left out and made again on request. */
  files?: boolean;
  /**
   * Encrypt archives with TANSY_BACKUP_KEY. Defaults to true. An archive holds every
   * account's password hash and live sessions, so turn this off only for a
   * destination that is already private and encrypted.
   */
  encrypt?: boolean;
}

export const DEFAULT_KEEP = 7;

export const keepOf = (config: BackupConfig) => config.keep ?? DEFAULT_KEEP;

/** The key to encrypt with, or null for a configuration that opted out. Throws when encryption is wanted and the key is unusable. */
export function encryptionKeyFor(config: BackupConfig | undefined): string | null {
  if (config?.encrypt === false) return null;
  const key = backupKey();
  if (config) assertBackupKey(key);
  return key;
}

/** Stops startup on a backup configuration that would fail at its first run. */
export function assertBackupsUsable(config: BackupConfig | undefined) {
  if (!config) return;
  if (!config.adapter) throw new Error("backups.adapter is required.");
  if (typeof config.adapter.list !== "function") throw new Error(`The backup storage "${config.adapter.name}" can't list its objects, which backups need to find and prune archives.`);
  config.adapter.assertUsable?.();
  if (config.schedule !== undefined) parseCron(config.schedule);
  const keep = keepOf(config);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("backups.keep must be a whole number of at least 1.");
  encryptionKeyFor(config);
}
