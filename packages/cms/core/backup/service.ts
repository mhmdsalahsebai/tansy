import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";
import type { ByteStream, StorageAdapter, StorageConfig } from "../storage/types";
import { TANSY_VERSION } from "../version";
import { hashEntry, indexTar, readEntry, readEntryText, TarWriter, type TarEntry } from "./archive";
import { decryptStream, ENCRYPTED_MAGIC, encryptStream, secretFingerprint } from "./crypto";
import { checkPostgresDump, checkSqliteCopy, databaseFromUrl, openSql, restoreDatabase, snapshotDatabase, type BackupDatabase, type SnapshotFile } from "./database";

export const BACKUP_PREFIX = "cms-backup-";
const NAME = /^cms-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-z0-9]{6}\.tar\.gz(\.enc)?$/;
const MANIFEST = "manifest.json";
/** Every key core gives an upload. Anything else in an archive is refused, so a crafted one can't write elsewhere in storage. */
const FILE_KEY = /^files\/[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{1,64}$/;
const PARALLEL_DOWNLOADS = 4;

const manifestSchema = z.object({
  format: z.literal(1),
  createdAt: z.string(),
  cmsVersion: z.string(),
  database: z.object({
    kind: z.enum(["sqlite", "postgres"]),
    entry: z.enum(["database.sqlite", "database.pgdump"]),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    migrations: z.array(z.string().max(255)),
  }),
  files: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    storage: z.string().max(100),
    key: z.string().regex(FILE_KEY),
    type: z.string().max(255),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
  missingFiles: z.array(z.object({ id: z.string(), storage: z.string(), key: z.string(), reason: z.string() })),
  secrets: z.object({ auth: z.string().nullable(), encryption: z.string().nullable() }),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

export interface BackupListing {
  name: string;
  size: number;
  createdAt: Date;
  encrypted: boolean;
}

export function backupName(now: Date, encrypted: boolean) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 6);
  return `${BACKUP_PREFIX}${stamp}-${suffix}.tar.gz${encrypted ? ".enc" : ""}`;
}

export function parseBackupName(name: string): Omit<BackupListing, "size"> | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, encrypted] = match;
  return { name, createdAt: new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`), encrypted: Boolean(encrypted) };
}

export const currentSecrets = () => ({
  auth: secretFingerprint(process.env.BETTER_AUTH_SECRET),
  // Settings fall back to a key derived from the auth secret when this isn't set.
  encryption: secretFingerprint(process.env.TANSY_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET),
});

const temporaryFolder = () => mkdtemp(path.join(tmpdir(), "cms-backup-"));

function adaptersOf(storage: StorageConfig | undefined) {
  const adapters = storage ? [storage.adapter, ...(storage.previous ?? [])] : [];
  return new Map(adapters.map((adapter) => [adapter.name, adapter]));
}

async function download(adapter: StorageAdapter, file: SnapshotFile, target: string) {
  adapter.assertUsable?.();
  const body = await adapter.get(file.key);
  if (!body) return false;
  await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target, { mode: 0o600 }));
  return true;
}

export interface CreatedBackup {
  name: string;
  /** The finished archive, inside `directory`. */
  path: string;
  bytes: number;
  manifest: BackupManifest;
  /** Removes the temporary folder and the archive in it. */
  cleanup(): Promise<void>;
}

export interface CreateOptions {
  database?: BackupDatabase;
  storage?: StorageConfig;
  /** Copy uploaded files. */
  files: boolean;
  /** Encrypt with this key, or write a plain .tar.gz when null. */
  key: string | null;
  now?: Date;
  log?: (line: string) => void;
}

/**
 * Snapshots the database, then copies every upload the snapshot knows about, so
 * the archive never names a file it doesn't hold. A file uploaded after the
 * snapshot isn't in it, and neither is its record. A file that has gone missing
 * from storage is listed in the manifest instead of failing the whole backup.
 */
export async function createBackup({ database = databaseFromUrl(), storage, files, key, now = new Date(), log = () => {} }: CreateOptions): Promise<CreatedBackup> {
  const directory = await temporaryFolder();
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    log(`Copying the ${database.kind === "sqlite" ? "SQLite" : "Postgres"} database.`);
    const snapshot = await snapshotDatabase(database, directory);
    const name = backupName(now, Boolean(key));
    const archive = path.join(directory, name);

    const tarStream = new PassThrough();
    const stages: Array<NodeJS.ReadWriteStream | NodeJS.WritableStream> = [createGzip({ level: 6 })];
    if (key) stages.push(encryptStream(key));
    const written = pipeline(tarStream, ...(stages as [Transform]), createWriteStream(archive, { mode: 0o600 }));
    // Surfaced through the awaits below. Without this, a failed write would also be an unhandled rejection.
    written.catch(() => {});
    const tar = new TarWriter(tarStream);

    const databaseEntry = database.kind === "sqlite" ? "database.sqlite" : "database.pgdump";
    const databaseSize = (await stat(snapshot.file)).size;
    const databaseHash = await tar.add(databaseEntry, databaseSize, createReadStream(snapshot.file));
    await rm(snapshot.file);

    const stored: BackupManifest["files"] = [];
    const missing: BackupManifest["missingFiles"] = [];
    if (files) {
      const adapters = adaptersOf(storage);
      log(`Copying ${snapshot.files.length} uploaded files.`);
      for (let start = 0; start < snapshot.files.length; start += PARALLEL_DOWNLOADS) {
        const batch = snapshot.files.slice(start, start + PARALLEL_DOWNLOADS);
        const fetched = await Promise.all(batch.map(async (file, index) => {
          const adapter = adapters.get(file.storage);
          if (!adapter) return { file, reason: `storage "${file.storage}" is not configured` };
          if (!FILE_KEY.test(file.key)) return { file, reason: "unexpected storage key" };
          const target = path.join(directory, `upload-${start + index}`);
          try {
            return (await download(adapter, file, target)) ? { file, target } : { file, reason: "not found in storage" };
          } catch (error) {
            return { file, reason: `could not be read: ${(error as Error).message}`.slice(0, 300) };
          }
        }));
        for (const result of fetched) {
          const { file } = result;
          if (!("target" in result) || !result.target) {
            missing.push({ id: file.id, storage: file.storage, key: file.key, reason: result.reason! });
            continue;
          }
          const size = (await stat(result.target)).size;
          const sha256 = await tar.add(`files/${file.id}`, size, createReadStream(result.target));
          await rm(result.target);
          stored.push({ id: file.id, storage: file.storage, key: file.key, type: file.type, size, sha256 });
        }
      }
    }

    const manifest: BackupManifest = {
      format: 1,
      createdAt: now.toISOString(),
      cmsVersion: TANSY_VERSION,
      database: { kind: database.kind, entry: databaseEntry, size: databaseSize, sha256: databaseHash, migrations: snapshot.migrations },
      files: stored,
      missingFiles: missing,
      secrets: currentSecrets(),
    };
    await tar.add(MANIFEST, Buffer.byteLength(JSON.stringify(manifest)), Buffer.from(JSON.stringify(manifest)));
    await tar.finish();
    await written;
    return { name, path: archive, bytes: (await stat(archive)).size, manifest, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function sendBackup(adapter: StorageAdapter, backup: Pick<CreatedBackup, "name" | "path" | "bytes">) {
  adapter.assertUsable?.();
  await adapter.put(backup.name, Readable.toWeb(createReadStream(backup.path)) as ByteStream, { size: backup.bytes, contentType: "application/octet-stream" });
}

export async function listBackups(adapter: StorageAdapter): Promise<BackupListing[]> {
  if (!adapter.list) throw new Error(`The backup storage "${adapter.name}" can't list its objects.`);
  adapter.assertUsable?.();
  const objects = await adapter.list(BACKUP_PREFIX);
  return objects
    .flatMap(({ key, size }) => {
      const parsed = parseBackupName(key);
      return parsed ? [{ ...parsed, size }] : [];
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Only archives this module named are ever deleted, newest first kept. */
export async function pruneBackups(adapter: StorageAdapter, keep: number, protect?: string) {
  const backups = await listBackups(adapter);
  const removed: string[] = [];
  for (const backup of backups.slice(keep)) {
    if (backup.name === protect) continue;
    await adapter.delete(backup.name);
    removed.push(backup.name);
  }
  return removed;
}

export async function downloadBackup(adapter: StorageAdapter, name: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  if (!parseBackupName(name)) throw new Error(`"${name}" is not a backup name.`);
  adapter.assertUsable?.();
  const body = await adapter.get(name);
  if (!body) throw new Error(`There is no backup called ${name}.`);
  const directory = await temporaryFolder();
  const file = path.join(directory, name);
  await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file, { mode: 0o600 }));
  return { path: file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export interface OpenedBackup {
  manifest: BackupManifest;
  tar: string;
  entries: Map<string, TarEntry>;
  encrypted: boolean;
  cleanup(): Promise<void>;
}

async function startsWith(file: string, magic: Buffer) {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(magic.length);
    const { bytesRead } = await handle.read(head, 0, magic.length, 0);
    return bytesRead === magic.length && head.equals(magic);
  } finally {
    await handle.close();
  }
}

/** Decrypts and unpacks an archive into a temporary folder, and reads its manifest. Nothing outside that folder is touched. */
export async function openBackup(file: string, key: string | null): Promise<OpenedBackup> {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${file} is not a file.`);
  const encrypted = await startsWith(file, ENCRYPTED_MAGIC);
  if (encrypted && !key) throw new Error("This backup is encrypted. Set TANSY_BACKUP_KEY to the key it was made with.");
  const directory = await temporaryFolder();
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const tar = path.join(directory, "backup.tar");
    const stages: Transform[] = encrypted ? [decryptStream(key!), createGunzip()] : [createGunzip()];
    try {
      await pipeline(createReadStream(file), ...stages, createWriteStream(tar, { mode: 0o600 }));
    } catch (error) {
      const message = (error as Error).message;
      if (encrypted && /TANSY_BACKUP_KEY|cut short/.test(message)) throw error;
      throw new Error(`This is not a readable tansy backup (${message}).`);
    }
    const entries = await indexTar(tar);
    const manifestEntry = entries.get(MANIFEST);
    if (!manifestEntry) throw new Error("This archive has no manifest, so it isn't a tansy backup.");
    const parsed = manifestSchema.safeParse(JSON.parse(await readEntryText(tar, manifestEntry, 256 * 1024 * 1024)));
    if (!parsed.success) throw new Error(`The backup's manifest isn't valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}.`);
    return { manifest: parsed.data, tar, entries, encrypted, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Checks every entry against the manifest's checksums, and that the database
 * copy is readable by its own tools. Run it on a schedule too: a backup nobody
 * has tried to read is a hope, not a backup.
 */
export async function verifyBackup(backup: OpenedBackup) {
  const { manifest, tar, entries } = backup;
  const check = async (name: string, size: number, sha256: string) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`The archive is missing ${name}.`);
    if (entry.size !== size || (await hashEntry(tar, entry)) !== sha256) throw new Error(`${name} in the archive is damaged: its checksum doesn't match.`);
  };
  await check(manifest.database.entry, manifest.database.size, manifest.database.sha256);
  for (const file of manifest.files) await check(`files/${file.id}`, file.size, file.sha256);

  const directory = await temporaryFolder();
  try {
    const copy = await extractDatabase(backup, directory);
    if (manifest.database.kind === "sqlite") checkSqliteCopy(copy);
    else await checkPostgresDump(copy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function extractDatabase({ manifest, tar, entries }: OpenedBackup, directory: string) {
  const target = path.join(directory, manifest.database.entry);
  const hash = createHash("sha256");
  const entry = entries.get(manifest.database.entry)!;
  await pipeline(readEntry(tar, entry), new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  }), createWriteStream(target, { mode: 0o600 }));
  if (hash.digest("hex") !== manifest.database.sha256) throw new Error("The database in the archive is damaged: its checksum doesn't match.");
  return target;
}

/** Problems that make a restore unsafe, each with what to do about it. */
export function restoreProblems(manifest: BackupManifest, database: BackupDatabase, knownMigrations: string[]) {
  const problems: Array<{ message: string; forceable: boolean }> = [];
  if (manifest.database.kind !== database.kind) {
    problems.push({
      forceable: false,
      message: `This backup is of a ${manifest.database.kind} database, and DATABASE_URL names a ${database.kind} one. A backup restores onto the same kind of database.`,
    });
  }
  const known = new Set(knownMigrations);
  // Each database has its own migrations, so they only compare between backups of the same kind.
  const newer = manifest.database.kind === database.kind ? manifest.database.migrations.filter((name) => !known.has(name)) : [];
  if (newer.length) {
    problems.push({
      forceable: false,
      message: `This backup was made by a newer tansy (${manifest.cmsVersion}), with database changes this version doesn't have: ${newer.slice(0, 3).join(", ")}${newer.length > 3 ? ", …" : ""}. Upgrade tansy, then restore.`,
    });
  }
  const secrets = currentSecrets();
  if (manifest.secrets.auth && secrets.auth && manifest.secrets.auth !== secrets.auth) {
    problems.push({ forceable: true, message: "BETTER_AUTH_SECRET differs from the one the backup was made with, so two-factor secrets and other values sealed with it won't open. Set the old secret, or pass --force to restore anyway." });
  }
  if (manifest.secrets.encryption && secrets.encryption && manifest.secrets.encryption !== secrets.encryption) {
    problems.push({ forceable: true, message: "TANSY_ENCRYPTION_KEY differs from the one the backup was made with, so stored SMTP, OAuth and webhook secrets won't decrypt. Set the old key, or pass --force to restore anyway." });
  }
  return problems;
}

/** Whether there is anything at DATABASE_URL worth a safety copy. */
export async function databaseHasData(database: BackupDatabase) {
  if (database.kind === "sqlite" && (!existsSync(database.file) || statSync(database.file).size === 0)) return false;
  const sql = await openSql(database);
  try {
    const rows = database.kind === "sqlite"
      ? await sql.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'`)
      : await sql.query(`SELECT to_regclass('public._prisma_migrations') AS name`);
    return Boolean(rows[0]?.name);
  } finally {
    await sql.close();
  }
}

export interface FilePlacement {
  /** Storage names in the backup that this server doesn't have, and the adapter their files went to. */
  renamed: Map<string, string>;
  restored: number;
}

/**
 * Puts every file back before the database is touched, so a storage failure
 * leaves the site exactly as it was. Keys never change, so writing a file that
 * is already there only rewrites the same bytes. Files whose storage is no
 * longer configured go to the current upload adapter.
 */
export async function restoreFiles(backup: OpenedBackup, storage: StorageConfig, log: (line: string) => void = () => {}): Promise<FilePlacement> {
  const adapters = adaptersOf(storage);
  const renamed = new Map<string, string>();
  let restored = 0;
  for (const file of backup.manifest.files) {
    const target = adapters.get(file.storage) ?? storage.adapter;
    if (target.name !== file.storage) renamed.set(file.storage, target.name);
    target.assertUsable?.();
    const entry = backup.entries.get(`files/${file.id}`);
    if (!entry || entry.size !== file.size) throw new Error(`The archive is missing files/${file.id}.`);
    await target.put(file.key, Readable.toWeb(readEntry(backup.tar, entry)) as ByteStream, { size: file.size, contentType: file.type });
    restored++;
    if (restored % 500 === 0) log(`  ${restored} of ${backup.manifest.files.length} files`);
  }
  return { renamed, restored };
}

export async function restoreDatabaseFrom(backup: OpenedBackup, database: BackupDatabase) {
  const directory = await temporaryFolder();
  try {
    await restoreDatabase(database, await extractDatabase(backup, directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * After the database is back and migrated: point files at the storage that now
 * holds them, have an outside search engine rebuilt, and end every session. Sessions revoked since the backup was made
 * would otherwise work again, and anyone signed in now would be signed in as
 * they were then.
 */
export async function finishRestore(database: BackupDatabase, { name, placement }: { name: string; placement: FilePlacement | null }) {
  const sql = await openSql(database);
  try {
    for (const [from, to] of placement?.renamed ?? []) await sql.query(`UPDATE "StoredFile" SET storage = $1 WHERE storage = $2`, [to, from]);
    await sql.query(`DELETE FROM "session"`);
    // An outside search engine still holds what was written after the backup, so the next start rebuilds it.
    await sql.query(`DELETE FROM "AppSetting" WHERE key = 'search.engine'`);
    await sql.query(
      `INSERT INTO "AuditLog" (id, at, action, outcome, "actorKind", "targetType", "targetId", metadata) VALUES ($1, $2, 'backup.restore', 'success', 'system', 'backup', $3, $4)`,
      [crypto.randomUUID(), new Date().toISOString(), name, sql.json({ via: "cli", files: placement?.restored ?? 0 })],
    );
  } finally {
    await sql.close();
  }
}

/** For backups made from the command line, where core's audit() isn't running. */
export async function recordBackupAudit(database: BackupDatabase, outcome: "success" | "failure", target: string, metadata: Record<string, unknown>) {
  const sql = await openSql(database);
  try {
    await sql.query(
      `INSERT INTO "AuditLog" (id, at, action, outcome, "actorKind", "targetType", "targetId", metadata) VALUES ($1, $2, 'backup.create', $3, 'system', 'backup', $4, $5)`,
      [crypto.randomUUID(), new Date().toISOString(), outcome, target, sql.json(metadata)],
    );
  } finally {
    await sql.close();
  }
}
