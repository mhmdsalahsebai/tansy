import { bodyBlob, callProvider, rangeOf, storageIndex, StorageProviderError, type StorageAdapter, type StorageIndex, type StoredObject } from "tansy/storage";

export interface ImgbbStorageOptions {
  /** IMGBB_API_KEY, from https://api.imgbb.com. */
  apiKey: string;
  /**
   * Where everything imgbb doesn't take goes: anything but a PNG, JPEG, GIF or WebP image, an
   * image over 32 MB, or one imgbb would store changed. Without it, such an upload is refused.
   */
  fallback?: StorageAdapter;
  /** Needed only when two imgbb accounts are in use at once, such as during a move. */
  name?: string;
}

/** What the adapter keeps for each key: the image's address on imgbb, or nothing for one in the fallback. */
export interface ImgbbEntry {
  url?: string;
  size: number;
}

const PROVIDER = "imgbb";
const UPLOAD = "https://api.imgbb.com/1/upload";
/** imgbb's own limit on one image. */
const MAX_BYTES = 32 * 1024 * 1024;
/** The raster images core serves inline, less AVIF, which imgbb isn't documented to take. */
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Only imgbb's own image host, so a changed index entry can't send a read anywhere else. */
function imageUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "i.ibb.co" || url.hostname.endsWith(".ibb.co")) ? url : null;
  } catch {
    return null;
  }
}

function entryOf(value: unknown): ImgbbEntry | null {
  if (!value || typeof value !== "object") return null;
  const { url, size } = value as Record<string, unknown>;
  if (typeof size !== "number") return null;
  if (url === undefined) return { size };
  const address = imageUrl(url);
  return address ? { url: address.href, size } : null;
}

/**
 * imgbb, a free image host, through its upload API. imgbb picks each image's address, so the adapter
 * keeps it in a storage index, under core's key.
 *
 * Every image on imgbb is public to anyone holding its address. The CMS never hands that address
 * out: it reads the image itself and serves it after its own access checks. But it can't be made
 * private, so this suits a public site's pictures, not files that must stay private.
 *
 * imgbb has no API to delete an image, so a deleted file's image stays on imgbb, unreachable from
 * the CMS, until removed by hand from the imgbb account.
 */
export function imgbbStorage(options: ImgbbStorageOptions, index?: StorageIndex<ImgbbEntry>, fetcher: typeof fetch = fetch): StorageAdapter {
  const { apiKey, fallback, name = "imgbb" } = options;
  const entries = index ?? storageIndex<ImgbbEntry>(name);
  const read = async (key: string) => entryOf(await entries.get(key));

  async function toFallback(key: string, body: ReadableStream<Uint8Array>, put: { size: number; contentType: string }, why: string) {
    if (!fallback) {
      await body.cancel();
      throw new Error(`imgbb storage can't keep this file: ${why}. Set a fallback adapter for it.`);
    }
    await fallback.put(key, body, put);
    await entries.set(key, { size: put.size });
  }

  async function upload(key: string, blob: Blob) {
    const form = new FormData();
    form.set("image", blob, key.split("/").pop() || "image");
    const url = new URL(UPLOAD);
    url.searchParams.set("key", apiKey);
    const response = await callProvider(PROVIDER, "upload", url, { method: "POST", body: form }, fetcher);
    let answer: { data?: { url?: unknown; size?: unknown; image?: { url?: unknown } } };
    try {
      answer = await response.json();
    } catch {
      throw new StorageProviderError(PROVIDER, "upload");
    }
    const address = imageUrl(answer.data?.image?.url ?? answer.data?.url);
    if (!address) throw new StorageProviderError(PROVIDER, "upload");
    return { url: address.href, size: Number(answer.data?.size) };
  }

  return {
    name,

    assertUsable() {
      if (!apiKey) throw new Error("imgbb storage needs an API key (IMGBB_API_KEY).");
      fallback?.assertUsable?.();
    },

    async put(key, body, put) {
      const previous = await read(key);
      if (!IMAGES.has(put.contentType)) {
        await toFallback(key, body, put, `imgbb takes PNG, JPEG, GIF and WebP images only, not ${put.contentType}`);
      } else if (put.size > MAX_BYTES) {
        await toFallback(key, body, put, "imgbb takes images up to 32 MB only");
      } else {
        const blob = await bodyBlob(body, put.contentType);
        const stored = await upload(key, blob);
        // The CMS serves the size it recorded, so an image imgbb recompressed would be served cut short or padded.
        if (stored.size !== put.size) await toFallback(key, blob.stream(), put, "imgbb would store it changed");
        else await entries.set(key, { url: stored.url, size: put.size });
      }
      // Replacing what a restore puts back: the old copy in the fallback goes. One on imgbb can't.
      if (previous && !previous.url) {
        const now = await read(key);
        if (now?.url) await fallback?.delete(key);
      }
    },

    async get(key, range) {
      const entry = await read(key);
      if (!entry) return null;
      if (!entry.url) return fallback ? fallback.get(key, range) : null;
      const response = await callProvider(PROVIDER, "read", entry.url, { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {}, allow: [404] }, fetcher);
      if (response.status === 404 || !response.body) {
        await response.body?.cancel();
        return null;
      }
      return rangeOf(response, range);
    },

    async delete(key) {
      const entry = await read(key);
      if (entry && !entry.url) await fallback?.delete(key);
      await entries.delete(key);
    },

    async list(prefix) {
      const found: StoredObject[] = [];
      for (const { key, value } of await entries.list(prefix)) {
        const entry = entryOf(value);
        if (entry) found.push({ key, size: entry.size });
      }
      return found;
    },
  };
}
