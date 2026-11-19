import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { indexTar, readEntryText, TarWriter } from "@/core/backup/archive";
import { assertBackupsUsable } from "@/core/backup/config";
import { decryptStream, encryptStream } from "@/core/backup/crypto";
import { libpqConnection } from "@/core/backup/database";
import {
  backupName, createBackup, finishRestore, listBackups, openBackup, parseBackupName, pruneBackups, restoreDatabaseFrom,
  restoreFiles, restoreProblems, sendBackup, verifyBackup, type BackupManifest,
} from "@/core/backup/service";
import { localStorage } from "@/core/storage/local";
import { s3Storage } from "@/core/storage/s3";

const KEY = "k".repeat(32);
const folders: string[] = [];
const folder = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cms-backup-test-"));
  folders.push(dir);
  return dir;
};
afterAll(() => folders.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
afterEach(() => vi.unstubAllEnvs());

const streamOf = (data: Buffer) => new Blob([new Uint8Array(data)]).stream();
const through = async (data: Buffer, ...stages: NodeJS.ReadWriteStream[]) => {
  let stream: NodeJS.ReadableStream = Readable.from([data]);
  for (const stage of stages) stream = stream.pipe(stage);
  return buffer(stream);
};

describe("archive", () => {
  it("writes a tar that indexes back to the same entries, including an empty one", async () => {
    const dir = folder();
    const file = path.join(dir, "a.tar");
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk) => chunks.push(chunk));
    const tar = new TarWriter(out);
    await tar.add("database.sqlite", 3, Buffer.from("abc"));
    await tar.add("files/empty", 0, Buffer.alloc(0));
    await tar.add("manifest.json", 1000, Readable.from([Buffer.alloc(600, 1), Buffer.alloc(400, 2)]));
    await tar.finish();
    writeFileSync(file, Buffer.concat(chunks));
    const entries = await indexTar(file);
    expect([...entries.keys()]).toEqual(["database.sqlite", "files/empty", "manifest.json"]);
    expect(await readEntryText(file, entries.get("database.sqlite")!)).toBe("abc");
    expect(await readEntryText(file, entries.get("files/empty")!)).toBe("");
    expect(entries.get("manifest.json")!.size).toBe(1000);
  });

  it("refuses a source that doesn't match its declared size, and unsafe names", async () => {
    const tar = new TarWriter(new PassThrough().resume());
    await expect(tar.add("a", 2, Buffer.from("abc"))).rejects.toThrow(/larger/);
    await expect(new TarWriter(new PassThrough().resume()).add("b", 5, Buffer.from("abc"))).rejects.toThrow(/smaller/);
    await expect(new TarWriter(new PassThrough().resume()).add("../etc/passwd", 1, Buffer.from("x"))).rejects.toThrow(/Invalid/);
  });
});

describe("encryption", () => {
  it.each([0, 1, 65_536, 65_537, 200_000])("round-trips %i bytes", async (size) => {
    const plain = Buffer.alloc(size, 7);
    const sealed = await through(plain, encryptStream(KEY));
    // A run of 16 plaintext bytes can't appear by chance; a single byte often does.
    if (size >= 16) expect(sealed.includes(Buffer.alloc(Math.min(size, 64), 7))).toBe(false);
    expect((await through(sealed, decryptStream(KEY))).equals(plain)).toBe(true);
  });

  it("fails on a wrong key, a changed byte, a dropped chunk or a cut-off end", async () => {
    const plain = Buffer.alloc(200_000, 3);
    const sealed = await through(plain, encryptStream(KEY));
    await expect(through(sealed, decryptStream("x".repeat(32)))).rejects.toThrow(/not the key/);
    const flipped = Buffer.from(sealed);
    flipped[1000] ^= 1;
    await expect(through(flipped, decryptStream(KEY))).rejects.toThrow(/damaged/);
    const header = 31;
    const chunk = 65_536 + 16;
    const dropped = Buffer.concat([sealed.subarray(0, header + chunk), sealed.subarray(header + 2 * chunk)]);
    await expect(through(dropped, decryptStream(KEY))).rejects.toThrow(/damaged/);
    // Ending on a chunk boundary looks complete, so the last-chunk flag is what catches it.
    await expect(through(sealed.subarray(0, header + 2 * chunk), decryptStream(KEY))).rejects.toThrow(/damaged/);
  });

  it("refuses short keys", () => {
    expect(() => encryptStream("short")).toThrow(/at least 32/);
  });
});

describe("configuration", () => {
  const adapter = () => localStorage({ dir: folder(), allowInProduction: true });

  it("needs a usable key unless encryption is turned off", () => {
    vi.stubEnv("TANSY_BACKUP_KEY", "");
    expect(() => assertBackupsUsable({ adapter: adapter() })).toThrow(/TANSY_BACKUP_KEY/);
    vi.stubEnv("TANSY_BACKUP_KEY", "too-short");
    expect(() => assertBackupsUsable({ adapter: adapter() })).toThrow(/at least 32/);
    expect(() => assertBackupsUsable({ adapter: adapter(), encrypt: false })).not.toThrow();
    vi.stubEnv("TANSY_BACKUP_KEY", KEY);
    expect(() => assertBackupsUsable({ adapter: adapter(), schedule: "0 3 * * *", keep: 3 })).not.toThrow();
  });

  it("refuses a bad schedule, a bad keep and storage that can't list", () => {
    vi.stubEnv("TANSY_BACKUP_KEY", KEY);
    expect(() => assertBackupsUsable({ adapter: adapter(), schedule: "daily" })).toThrow(/five fields/);
    expect(() => assertBackupsUsable({ adapter: adapter(), keep: 0 })).toThrow(/keep/);
    expect(() => assertBackupsUsable({ adapter: { ...adapter(), list: undefined } })).toThrow(/can't list/);
  });
});

describe("names and retention", () => {
  it("names archives so they sort by time", () => {
    const name = backupName(new Date("2026-11-15T03:00:00.123Z"), true);
    expect(name).toMatch(/^cms-backup-20261115T030000Z-[a-z0-9]{6}\.tar\.gz\.enc$/);
    expect(parseBackupName(name)).toMatchObject({ createdAt: new Date("2026-11-15T03:00:00Z"), encrypted: true });
    expect(parseBackupName("files/ab/cms-backup-x.tar.gz")).toBeNull();
  });

  it("keeps the newest archives and never touches other objects", async () => {
    const dir = folder();
    const adapter = localStorage({ dir });
    const names = ["20261101", "20261102", "20261103", "20261104"].map((day) => `cms-backup-${day}T000000Z-aaaaaa.tar.gz`);
    for (const name of [...names, "files/ab/abc", "cms-backup-notes.txt"]) await adapter.put(name, streamOf(Buffer.from("x")), { size: 1, contentType: "x" });
    writeFileSync(path.join(dir, `${names[0]}.123.partial`), "x");
    expect((await listBackups(adapter)).map((backup) => backup.name)).toEqual([...names].reverse());
    expect(await pruneBackups(adapter, 2)).toEqual([names[1], names[0]]);
    expect(existsSync(path.join(dir, "files/ab/abc"))).toBe(true);
    expect(existsSync(path.join(dir, "cms-backup-notes.txt"))).toBe(true);
    expect((await listBackups(adapter)).map((backup) => backup.name)).toEqual([names[3], names[2]]);
  });
});

describe("s3Storage list", () => {
  let server: Server;
  let endpoint: string;
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push(request.url!);
      const url = new URL(request.url!, "http://x");
      const second = url.searchParams.get("continuation-token") === "next&1";
      response.setHeader("content-type", "application/xml");
      response.end(second
        ? "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>site/cms-backup-b&amp;.tar.gz</Key><Size>5</Size></Contents></ListBucketResult>"
        : "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;1</NextContinuationToken><Contents><Key>site/cms-backup-a.tar.gz</Key><Size>3</Size></Contents></ListBucketResult>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("follows continuation tokens and strips the adapter's prefix", async () => {
    const adapter = s3Storage({ endpoint, bucket: "b", accessKeyId: "a", secretAccessKey: "s", prefix: "site" });
    expect(await adapter.list!("cms-backup-")).toEqual([{ key: "cms-backup-a.tar.gz", size: 3 }, { key: "cms-backup-b&.tar.gz", size: 5 }]);
    expect(seen[0]).toMatch(/^\/b\/\?list-type=2&prefix=site%2Fcms-backup-$/);
    expect(seen[1]).toContain("continuation-token=next%261");
  });
});

describe("libpqConnection", () => {
  it("moves the password to the environment and drops parameters libpq refuses", () => {
    vi.stubEnv("PGHOST", "elsewhere");
    const { dbname, env } = libpqConnection("postgresql://cms:p%40ss@db.test:5432/cms?schema=public&sslmode=require&connection_limit=5");
    expect(dbname).toBe("postgresql://cms@db.test:5432/cms?sslmode=require");
    expect(env.PGPASSWORD).toBe("p@ss");
    expect(env.PGHOST).toBeUndefined();
  });
});

function makeDatabase(file: string, files: Array<{ id: string; key: string }>) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE "_prisma_migrations" (migration_name TEXT, finished_at TEXT, rolled_back_at TEXT);
    INSERT INTO "_prisma_migrations" VALUES ('20261109000000_baseline', '2026-11-09', NULL), ('20261110000000_rolled', '2026-11-10', '2026-11-10');
    CREATE TABLE "StoredFile" (id TEXT PRIMARY KEY, storage TEXT, key TEXT, size INTEGER, type TEXT);
    CREATE TABLE "session" (id TEXT PRIMARY KEY);
    CREATE TABLE "AppSetting" (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE "AuditLog" (id TEXT, at TEXT, action TEXT, outcome TEXT, "actorKind" TEXT, "targetType" TEXT, "targetId" TEXT, metadata TEXT);
    CREATE TABLE rec_posts (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO rec_posts (title) VALUES ('kept');
    INSERT INTO session VALUES ('then');
    INSERT INTO "AppSetting" VALUES ('search.engine', '"meilisearch:https://search.example.com/tansy"');
  `);
  for (const file of files) db.prepare(`INSERT INTO "StoredFile" VALUES (?, 'old-disk', ?, 5, 'text/plain')`).run(file.id, file.key);
  return db;
}

describe("backup and restore", () => {
  it("round-trips the database and uploads, and lists what storage couldn't supply", async () => {
    const dir = folder();
    const live = path.join(dir, "live.db");
    const uploads = localStorage({ dir: path.join(dir, "old-uploads") });
    const oldDisk = { ...uploads, name: "old-disk" };
    await oldDisk.put("files/ab/abcdef", streamOf(Buffer.from("hello")), { size: 5, contentType: "text/plain" });
    makeDatabase(live, [{ id: "abcdef", key: "files/ab/abcdef" }, { id: "gone", key: "files/go/gone" }]).close();

    const backup = await createBackup({ database: { kind: "sqlite", file: live }, storage: { adapter: oldDisk }, files: true, key: KEY });
    const target = localStorage({ dir: path.join(dir, "backups") });
    await sendBackup(target, backup);
    await backup.cleanup();
    expect(backup.manifest.database.migrations).toEqual(["20261109000000_baseline"]);
    expect(backup.manifest.files.map((file) => file.id)).toEqual(["abcdef"]);
    expect(backup.manifest.missingFiles).toEqual([expect.objectContaining({ id: "gone", reason: "not found in storage" })]);

    // Everything after the backup is what a restore should undo.
    const changed = new Database(live);
    changed.exec(`DELETE FROM rec_posts; CREATE TABLE rec_later (id INTEGER); INSERT INTO session VALUES ('now');`);
    changed.close();

    const [listed] = await listBackups(target);
    const opened = await openBackup(path.join(dir, "backups", listed.name), KEY);
    try {
      await verifyBackup(opened);
      expect(restoreProblems(opened.manifest, { kind: "sqlite", file: live }, ["20261109000000_baseline"])).toEqual([]);
      const newUploads = localStorage({ dir: path.join(dir, "new-uploads") });
      const placement = await restoreFiles(opened, { adapter: newUploads });
      expect(placement).toEqual({ renamed: new Map([["old-disk", "local"]]), restored: 1 });
      await restoreDatabaseFrom(opened, { kind: "sqlite", file: live });
      await finishRestore({ kind: "sqlite", file: live }, { name: listed.name, placement });
      expect(readFileSync(path.join(dir, "new-uploads/files/ab/abcdef"), "utf8")).toBe("hello");
    } finally {
      await opened.cleanup();
    }

    const restored = new Database(live);
    expect(restored.prepare("SELECT title FROM rec_posts").all()).toEqual([{ title: "kept" }]);
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name = 'rec_later'").all()).toEqual([]);
    expect(restored.prepare("SELECT count(*) AS count FROM session").get()).toEqual({ count: 0 });
    // So the next start rebuilds an outside search engine, which still holds what came after the backup.
    expect(restored.prepare(`SELECT count(*) AS count FROM "AppSetting" WHERE key = 'search.engine'`).get()).toEqual({ count: 0 });
    expect(restored.prepare(`SELECT DISTINCT storage FROM "StoredFile"`).all()).toEqual([{ storage: "local" }]);
    expect(restored.prepare(`SELECT action, "targetId" FROM "AuditLog"`).all()).toEqual([{ action: "backup.restore", targetId: listed.name }]);
    expect(restored.pragma("journal_mode", { simple: true })).toBe("wal");
    restored.close();
  });

  it("refuses an archive whose manifest names a key outside uploads", async () => {
    const dir = folder();
    const live = path.join(dir, "live.db");
    makeDatabase(live, []).close();
    const backup = await createBackup({ database: { kind: "sqlite", file: live }, files: false, key: null });
    const opened = await openBackup(backup.path, null);
    const manifest = JSON.parse(await readEntryText(opened.tar, opened.entries.get("manifest.json")!)) as BackupManifest;
    await opened.cleanup();
    await backup.cleanup();

    const crafted = path.join(dir, "crafted.tar");
    manifest.files.push({ id: "x", storage: "local", key: "../../etc/cron.d/x", type: "text/plain", size: 0, sha256: "0".repeat(64) });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk) => chunks.push(chunk));
    const tar = new TarWriter(out);
    const text = Buffer.from(JSON.stringify(manifest));
    await tar.add("manifest.json", text.length, text);
    await tar.finish();
    const { gzipSync } = await import("node:zlib");
    writeFileSync(crafted, gzipSync(Buffer.concat(chunks)));
    await expect(openBackup(crafted, null)).rejects.toThrow(/manifest isn't valid/);
  });

  it("reports what makes a restore unsafe", () => {
    vi.stubEnv("TANSY_ENCRYPTION_KEY", "now-key-now-key-now-key-now-key!");
    const manifest = {
      format: 1, createdAt: "", cmsVersion: "9.0.0", files: [], missingFiles: [],
      database: { kind: "sqlite", entry: "database.sqlite", size: 0, sha256: "0".repeat(64), migrations: ["a", "z_future"] },
      secrets: { auth: null, encryption: "0000000000000000" },
    } satisfies BackupManifest;
    const sqlite = { kind: "sqlite", file: "x" } as const;
    expect(restoreProblems(manifest, sqlite, ["a"]).map(({ forceable, message }) => [forceable, message.split(" ").slice(0, 4).join(" ")])).toEqual([
      [false, "This backup was made"],
      [true, "TANSY_ENCRYPTION_KEY differs from the"],
    ]);
    expect(restoreProblems(manifest, { kind: "postgres", url: "postgres://x" }, []).map(({ message }) => message.slice(0, 30))).toEqual([
      "This backup is of a sqlite dat",
      "TANSY_ENCRYPTION_KEY differs f",
    ]);
  });
});

it("keeps the local list free of half-written files", async () => {
  const dir = folder();
  mkdirSync(path.join(dir, "files/ab"), { recursive: true });
  writeFileSync(path.join(dir, "files/ab/x"), "12");
  writeFileSync(path.join(dir, "files/ab/x.1.partial"), "1");
  expect(await localStorage({ dir }).list!("files/")).toEqual([{ key: "files/ab/x", size: 2 }]);
  expect(await localStorage({ dir: path.join(dir, "nothing-here") }).list!("")).toEqual([]);
});
