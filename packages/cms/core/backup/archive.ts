import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, type Writable } from "node:stream";

/**
 * A plain POSIX tar (ustar) writer and reader, enough for archives this module
 * writes itself. An unencrypted backup is an ordinary .tar.gz, so it can be
 * opened with `tar xzf` when the CMS isn't at hand.
 */

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;

export interface TarEntry {
  name: string;
  /** Where the entry's bytes start in the uncompressed tar. */
  offset: number;
  size: number;
}

function octal(header: Buffer, value: number, at: number, width: number) {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, at, width, "ascii");
}

/** GNU base-256 for sizes over 8 GiB, which a database alone can reach. */
function sizeField(header: Buffer, size: number) {
  if (size <= MAX_OCTAL_SIZE) return octal(header, size, 124, 12);
  header[124] = 0x80;
  let rest = size;
  for (let index = 135; index > 124; index--) {
    header[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

/** Up to the first NUL. */
const field = (header: Buffer, start: number, end: number) => header.toString("ascii", start, end).split("\0")[0];

function readSize(header: Buffer) {
  if (header[124] & 0x80) {
    let size = 0;
    for (let index = 125; index < 136; index++) size = size * 256 + header[index];
    return size;
  }
  return parseInt(field(header, 124, 136).trim() || "0", 8);
}

const checksum = (header: Buffer) => {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum;
};

/** Names are chosen by this module, so they are short ASCII paths. */
const NAME = /^(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+)*$/;

function header(name: string, size: number, mtime: number) {
  if (!NAME.test(name) || name.length > 100) throw new Error(`Invalid archive entry name "${name}".`);
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "ascii");
  octal(block, 0o600, 100, 8);
  octal(block, 0, 108, 8);
  octal(block, 0, 116, 8);
  sizeField(block, size);
  octal(block, Math.floor(mtime / 1000), 136, 12);
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(`${checksum(block).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

export class TarWriter {
  private readonly mtime = Date.now();

  constructor(private readonly out: Writable) {}

  private write(chunk: Buffer | Uint8Array) {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.out.once("error", onError);
      const flushed = this.out.write(chunk, () => undefined);
      const done = () => {
        this.out.off("error", onError);
        resolve();
      };
      if (flushed) done();
      else this.out.once("drain", done);
    });
  }

  /** Writes one entry and returns its SHA-256. Fails if the source holds more or fewer bytes than `size`. */
  async add(name: string, size: number, source: Readable | Buffer): Promise<string> {
    await this.write(header(name, size, this.mtime));
    const hash = createHash("sha256");
    let written = 0;
    const chunks = Buffer.isBuffer(source) ? [source] : source;
    for await (const chunk of chunks as AsyncIterable<Buffer>) {
      written += chunk.length;
      if (written > size) throw new Error(`"${name}" is larger than its recorded size.`);
      hash.update(chunk);
      await this.write(chunk);
    }
    if (written !== size) throw new Error(`"${name}" is smaller than its recorded size.`);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padding) await this.write(Buffer.alloc(padding));
    return hash.digest("hex");
  }

  async finish() {
    await this.write(Buffer.alloc(BLOCK * 2));
    await new Promise<void>((resolve, reject) => {
      this.out.once("error", reject);
      this.out.end(() => resolve());
    });
  }
}

/** Lists the entries of an uncompressed tar file without reading their contents. */
export async function indexTar(file: string): Promise<Map<string, TarEntry>> {
  const entries = new Map<string, TarEntry>();
  const handle = await open(file, "r");
  try {
    const { size: total } = await handle.stat();
    const block = Buffer.alloc(BLOCK);
    let offset = 0;
    while (offset + BLOCK <= total) {
      await handle.read(block, 0, BLOCK, offset);
      if (block.every((byte) => byte === 0)) return entries;
      const stored = parseInt(field(block, 148, 156).trim(), 8);
      if (stored !== checksum(block)) throw new Error("The archive is damaged: a header checksum doesn't match.");
      const name = field(block, 0, 100);
      const size = readSize(block);
      const type = String.fromCharCode(block[156]);
      if ((type === "0" || type === "\0") && NAME.test(name)) {
        if (entries.has(name)) throw new Error(`The archive holds "${name}" twice.`);
        entries.set(name, { name, offset: offset + BLOCK, size });
      }
      offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
      if (offset > total) throw new Error("The archive is cut short.");
    }
    throw new Error("The archive is cut short.");
  } finally {
    await handle.close();
  }
}

export function readEntry(file: string, entry: TarEntry): Readable {
  // An empty range would read the whole file.
  if (!entry.size) return Readable.from([]);
  return createReadStream(file, { start: entry.offset, end: entry.offset + entry.size - 1 });
}

export async function hashEntry(file: string, entry: TarEntry) {
  const hash = createHash("sha256");
  for await (const chunk of readEntry(file, entry)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function readEntryText(file: string, entry: TarEntry, limit = 64 * 1024 * 1024) {
  if (entry.size > limit) throw new Error(`"${entry.name}" is too large.`);
  const chunks: Buffer[] = [];
  for await (const chunk of readEntry(file, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
