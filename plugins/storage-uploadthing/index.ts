import { bodyBlob, callProvider, rangeOf, StorageProviderError, type StorageAdapter, type StoredObject } from "tansy/storage";
import type { UTApi } from "uploadthing/server";

export interface UploadthingStorageOptions {
  /** UPLOADTHING_TOKEN, from the app's API Keys page. */
  token: string;
  /** Keeps several sites in one app. */
  prefix?: string;
  /** Needed only when two apps are in use at once, such as during a move. */
  name?: string;
}

/** The part of Uploadthing's server SDK this adapter uses. */
export type UploadthingClient = Pick<UTApi, "uploadFiles" | "deleteFiles" | "listFiles" | "getSignedURL">;

const PROVIDER = "Uploadthing";
const PAGE = 500;
/** Seconds a read's signed URL lives. It's fetched at once and never leaves the server. */
const READ_SECONDS = 60;

/** The SDK's errors can carry its request, so only the action is kept. */
async function sdk<T>(action: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch {
    throw new StorageProviderError(PROVIDER, action);
  }
}

/**
 * Uploadthing, through its server SDK. Files are uploaded private, under core's key as
 * their custom id, and read through signed URLs the CMS fetches itself, so they're
 * served only after its access checks. Uploadthing needs a private ACL allowed on the app.
 */
export function uploadthingStorage(options: UploadthingStorageOptions, client?: UploadthingClient, fetcher: typeof fetch = fetch): StorageAdapter {
  const { token, prefix = "", name = "uploadthing" } = options;
  const keyPrefix = prefix ? `${prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const customId = (key: string) => keyPrefix + key;
  let api: Promise<UploadthingClient> | undefined = client && Promise.resolve(client);
  // Loaded and built on first use: the SDK is large, and a build without the token in its environment still succeeds.
  const ut = () => (api ??= import("uploadthing/server").then(({ UTApi }) => new UTApi({ token })));
  const byId = { keyType: "customId" } as const;

  return {
    name,

    assertUsable() {
      if (!token) throw new Error("Uploadthing storage needs the app's token (UPLOADTHING_TOKEN).");
    },

    async put(key, body, { contentType }) {
      const id = customId(key);
      const blob = await bodyBlob(body, contentType);
      // Custom ids are unique, so an object being replaced, as in a restore, goes first.
      await sdk("delete", async () => (await ut()).deleteFiles(id, byId));
      const { UTFile } = await import("uploadthing/server");
      const file = new UTFile([blob], key.split("/").pop() || "file", { customId: id, type: contentType });
      const result = await sdk("upload", async () => (await ut()).uploadFiles(file, { acl: "private", contentDisposition: "attachment" }));
      if (result.error) throw new StorageProviderError(PROVIDER, "upload");
    },

    async get(key, range) {
      let url: string;
      try {
        url = (await (await ut()).getSignedURL(customId(key), { ...byId, expiresIn: READ_SECONDS })).ufsUrl;
      } catch (error) {
        if ((error as { code?: unknown }).code === "NOT_FOUND") return null;
        throw new StorageProviderError(PROVIDER, "read");
      }
      const response = await callProvider(PROVIDER, "read", url, { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {}, allow: [404] }, fetcher);
      if (response.status === 404 || !response.body) {
        await response.body?.cancel();
        return null;
      }
      return rangeOf(response, range);
    },

    async delete(key) {
      await sdk("delete", async () => (await ut()).deleteFiles(customId(key), byId));
    },

    async list(listPrefix) {
      const wanted = customId(listPrefix);
      const found: StoredObject[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await sdk("list", async () => (await ut()).listFiles({ limit: PAGE, offset }));
        for (const file of page.files) {
          if (file.status === "Uploaded" && file.customId?.startsWith(wanted)) found.push({ key: file.customId.slice(keyPrefix.length), size: file.size });
        }
        if (!page.hasMore) return found;
      }
    },
  };
}
