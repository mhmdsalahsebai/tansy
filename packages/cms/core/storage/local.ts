import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ByteRange, ByteStream, StorageAdapter, StoredObject } from "./types";

export interface LocalStorageOptions {
  /** Must be outside `public/`, or files would be served with no access check. */
  dir: string;
  /** Local disk is for development. Set this to accept it in production, for example on one server with a backed-up volume. */
  allowInProduction?: boolean;
}

/** Has no signed URLs, so every read goes through the CMS's access checks. */
export function localStorage({ dir, allowInProduction = false }: LocalStorageOptions): StorageAdapter {
  const root = path.resolve(dir);

  const resolve = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("Storage key is outside the storage directory.");
    return full;
  };

  return {
    name: "local",

    assertUsable() {
      if (process.env.NODE_ENV === "production" && !allowInProduction) {
        throw new Error("Local file storage is for development. Configure remote storage in tansy.config.ts, or set allowInProduction: true to keep files on this server.");
      }
      const publicDir = path.resolve("public");
      if (root === publicDir || root.startsWith(publicDir + path.sep)) {
        throw new Error("The storage directory must be outside public/, or files would skip access checks.");
      }
    },

    async put(key: string, body: ByteStream) {
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      // Renamed into place, so a failed write never leaves a partial file under the real key.
      const partial = `${target}.${crypto.randomUUID()}.partial`;
      try {
        await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial));
        await rename(partial, target);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
    },

    async get(key: string, range?: ByteRange) {
      try {
        const handle = await open(resolve(key), "r");
        const stream = handle.createReadStream(range ? { start: range.start, end: range.end } : {});
        return Readable.toWeb(stream) as ByteStream;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async delete(key: string) {
      await rm(resolve(key), { force: true });
    },

    async list(prefix: string) {
      let names: string[];
      try {
        names = await readdir(root, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const found: StoredObject[] = [];
      for (const name of names) {
        const key = name.split(path.sep).join("/");
        // A write still in progress isn't an object yet.
        if (!key.startsWith(prefix) || key.endsWith(".partial")) continue;
        const info = await stat(path.join(root, name)).catch(() => null);
        if (info?.isFile()) found.push({ key, size: info.size });
      }
      return found;
    },
  };
}
