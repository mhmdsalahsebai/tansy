import { createHash } from "node:crypto";
import { bodyBlob, callProvider, rangeOf, type ProviderCall, type StorageAdapter, type StoredObject, type ThumbnailOptions } from "tansy/storage";

export interface CloudinaryStorageOptions {
  /** From the Cloudinary console's dashboard. */
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** The account's signature algorithm, under Settings → Security. Defaults to "sha1". */
  signatureAlgorithm?: "sha1" | "sha256";
  /** A folder holding every key, to keep several sites in one account. */
  prefix?: string;
  /** Needed only when two Cloudinary accounts are in use at once, such as during a move. */
  name?: string;
}

const PROVIDER = "Cloudinary";
const CLOUD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const API = "https://api.cloudinary.com/v1_1";
const DELIVERY = "https://res.cloudinary.com";
/** Uploaded as images, so Cloudinary can resize them. Everything else is stored untouched as raw. */
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const KINDS = ["image", "raw"] as const;
type Kind = (typeof KINDS)[number];
/** Only reachable with a signature, from the delivery network or the API. */
const TYPE = "authenticated";
const PAGE = 500;

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** Resizes without enlarging, as core's own thumbnails do, and converts to WebP. */
export function cloudinaryTransformation({ width, height, fit }: Pick<ThumbnailOptions, "width" | "height" | "fit">) {
  const size = fit === "cover" && height ? `c_lfill,h_${height},w_${width}` : `c_limit,w_${width}`;
  return `${size},f_webp,q_80`;
}

/**
 * Cloudinary, through its upload, admin and delivery APIs. Files are stored as
 * authenticated assets, so neither their address nor a guessed one serves them.
 *
 * Thumbnails are handed to Cloudinary. Its signed delivery URLs don't expire, so
 * core fetches them on the server and never sends one to a browser.
 */
export function cloudinaryStorage(options: CloudinaryStorageOptions, fetcher: typeof fetch = fetch): StorageAdapter {
  const { cloudName, apiKey, apiSecret, signatureAlgorithm = "sha1", prefix = "", name = "cloudinary" } = options;
  const keyPrefix = prefix ? `${prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const publicId = (key: string) => keyPrefix + key;

  const hash = (text: string, encoding: "hex" | "base64") => createHash(signatureAlgorithm).update(text).digest(encoding);

  /** Parameters sorted by name, signed with the secret, as Cloudinary's API expects. */
  const signed = (params: Record<string, string>) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const all = { ...params, timestamp };
    const toSign = Object.keys(all).sort().map((key) => `${key}=${all[key as keyof typeof all]}`.replace(/&/g, "%26")).join("&");
    return { ...all, api_key: apiKey, signature: hash(toSign + apiSecret, "hex") };
  };

  const form = (params: Record<string, string>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(signed(params))) body.append(key, value);
    return body;
  };

  const call = (action: string, url: string, init?: ProviderCall) => callProvider(PROVIDER, action, url, init, fetcher);

  const readAs = async (kind: Kind, key: string, range?: { start: number; end: number }) => {
    const query = new URLSearchParams(signed({ public_id: publicId(key), type: TYPE }));
    const response = await call("read", `${API}/${cloudName}/${kind}/download?${query}`, { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {}, allow: [404] });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return response;
  };

  return {
    name,

    assertUsable() {
      const missing = Object.entries({ cloudName, apiKey, apiSecret }).filter(([, value]) => !value).map(([key]) => key);
      if (missing.length) throw new Error(`Cloudinary storage is missing: ${missing.join(", ")}.`);
      // The cloud name becomes part of every address, so it can't be allowed to pick another one.
      if (!CLOUD_NAME.test(cloudName)) throw new Error("Cloudinary's cloud name may hold only letters, digits, - and _.");
    },

    async put(key, body, { contentType }) {
      const kind: Kind = IMAGES.has(contentType) ? "image" : "raw";
      const upload = form({ public_id: publicId(key), type: TYPE, overwrite: "true", invalidate: "true" });
      upload.append("file", await bodyBlob(body, contentType), "upload");
      const response = await call("upload", `${API}/${cloudName}/${kind}/upload`, { method: "POST", body: upload });
      await response.body?.cancel();
    },

    // The kind isn't known from the key, so images are tried first.
    async get(key, range) {
      for (const kind of KINDS) {
        const response = await readAs(kind, key, range);
        if (response?.body) return rangeOf(response, range);
      }
      return null;
    },

    async delete(key) {
      for (const kind of KINDS) {
        const response = await call("delete", `${API}/${cloudName}/${kind}/destroy`, { method: "POST", body: form({ public_id: publicId(key), type: TYPE, invalidate: "true" }) });
        // Answers "not found" with 200 for an asset that is already gone.
        await response.body?.cancel();
      }
    },

    async list(listPrefix) {
      const found: StoredObject[] = [];
      const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
      for (const kind of KINDS) {
        let cursor: string | undefined;
        do {
          const query = new URLSearchParams({ prefix: publicId(listPrefix), max_results: String(PAGE), ...(cursor ? { next_cursor: cursor } : {}) });
          const response = await call("list", `${API}/${cloudName}/resources/${kind}/${TYPE}?${query}`, { headers: { authorization } });
          const page = (await response.json()) as { resources?: { public_id?: unknown; bytes?: unknown }[]; next_cursor?: unknown };
          for (const { public_id: id, bytes } of page.resources ?? []) {
            if (typeof id === "string" && id.startsWith(keyPrefix)) found.push({ key: id.slice(keyPrefix.length), size: Number(bytes) || 0 });
          }
          cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
        } while (cursor);
      }
      return found;
    },

    async thumbnailUrl(key, thumbnail) {
      const transformation = cloudinaryTransformation(thumbnail);
      const source = encodeKey(publicId(key));
      // The first 8 characters of the URL-safe hash of the transformation, the id and the secret.
      const signature = hash(`${transformation}/${source}${apiSecret}`, "base64").slice(0, 8).replace(/\//g, "_").replace(/\+/g, "-");
      return `${DELIVERY}/${cloudName}/image/${TYPE}/s--${signature}--/${transformation}/v1/${source}`;
    },
  };
}
