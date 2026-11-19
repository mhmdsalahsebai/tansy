import { callProvider, rangeOf, type ProviderCall, type StorageAdapter, type StoredObject } from "tansy/storage";

export interface VercelBlobStorageOptions {
  /** BLOB_READ_WRITE_TOKEN of a private Blob store. A public store would serve every file to anyone with its address. */
  token: string;
  /** Keeps several sites in one store. */
  prefix?: string;
  /** Needed only when two stores are in use at once, such as during a move. */
  name?: string;
}

const PROVIDER = "Vercel Blob";
const API = "https://vercel.com/api/blob";
/** The version of the Blob API these requests are written for. */
const API_VERSION = "13";
/** vercel_blob_rw_<store id>_<secret>. */
const TOKEN = /^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/;
const PAGE = 1000;

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * A private Vercel Blob store, through its REST API. Every read needs the token,
 * so files are served only by the CMS, after its access checks. Vercel signs URLs
 * for private blobs, but can't set their download name or disposition, so the
 * adapter doesn't offer them.
 */
export function vercelBlobStorage(options: VercelBlobStorageOptions, fetcher: typeof fetch = fetch): StorageAdapter {
  const { token, prefix = "", name = "vercel-blob" } = options;
  const keyPrefix = prefix ? `${prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const storeId = () => TOKEN.exec(token)?.[1] ?? "";
  const pathname = (key: string) => keyPrefix + key;
  const blobUrl = (key: string) => `https://${storeId()}.private.blob.vercel-storage.com/${encodeKey(pathname(key))}`;

  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "x-api-version": API_VERSION, "x-vercel-blob-store-id": storeId(), ...extra });
  const call = (action: string, url: string, init?: ProviderCall) => callProvider(PROVIDER, action, url, init, fetcher);

  return {
    name,

    assertUsable() {
      if (!token) throw new Error("Vercel Blob storage needs the store's read-write token.");
      if (!TOKEN.test(token)) throw new Error("Vercel Blob's token should look like vercel_blob_rw_<store>_<secret>.");
    },

    async put(key, body, { size, contentType }) {
      const response = await call("upload", `${API}/?${new URLSearchParams({ pathname: pathname(key) })}`, {
        method: "PUT",
        headers: headers({
          "x-vercel-blob-access": "private",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
          "x-content-type": contentType,
          "x-content-length": String(size),
        }),
        body,
      });
      await response.body?.cancel();
    },

    async get(key, range) {
      const response = await call("read", blobUrl(key), { headers: { authorization: `Bearer ${token}`, ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}) }, allow: [404] });
      if (response.status === 404 || !response.body) {
        await response.body?.cancel();
        return null;
      }
      return rangeOf(response, range);
    },

    // Deleting a blob that's already gone succeeds.
    async delete(key) {
      const response = await call("delete", `${API}/delete`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ urls: [blobUrl(key)] }) });
      await response.body?.cancel();
    },

    async list(listPrefix) {
      const found: StoredObject[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ prefix: pathname(listPrefix), limit: String(PAGE), ...(cursor ? { cursor } : {}) });
        const response = await call("list", `${API}/?${query}`, { headers: headers() });
        const page = (await response.json()) as { blobs?: { pathname?: unknown; size?: unknown }[]; cursor?: unknown; hasMore?: unknown };
        for (const { pathname: path, size } of page.blobs ?? []) {
          if (typeof path === "string" && path.startsWith(keyPrefix)) found.push({ key: path.slice(keyPrefix.length), size: Number(size) || 0 });
        }
        cursor = page.hasMore === true && typeof page.cursor === "string" ? page.cursor : undefined;
      } while (cursor);
      return found;
    },
  };
}
