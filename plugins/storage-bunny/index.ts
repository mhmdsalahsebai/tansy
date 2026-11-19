import { createHmac } from "node:crypto";
import { callProvider, rangeOf, type ProviderCall, type StorageAdapter, type StoredObject, type ThumbnailOptions } from "tansy/storage";

/** Each Bunny Storage region's API host. */
const REGIONS = {
  de: "storage.bunnycdn.com",
  uk: "uk.storage.bunnycdn.com",
  se: "se.storage.bunnycdn.com",
  ny: "ny.storage.bunnycdn.com",
  la: "la.storage.bunnycdn.com",
  sg: "sg.storage.bunnycdn.com",
  syd: "syd.storage.bunnycdn.com",
  br: "br.storage.bunnycdn.com",
  jh: "jh.storage.bunnycdn.com",
} as const;

export interface BunnyStorageOptions {
  storageZone: string;
  /** The storage zone's password, under FTP & API Access. Not the account's API key. */
  accessKey: string;
  /** The storage zone's main region. Defaults to "de" (Falkenstein). */
  region?: keyof typeof REGIONS;
  /**
   * A pull zone serving this storage zone, with Bunny Optimizer and token authentication
   * turned on. Bunny then makes thumbnails, and browsers fetch them from it directly.
   * Without it, core makes and stores thumbnails itself.
   */
  cdn?: {
    /** Such as https://example.b-cdn.net. Add it to `csp.img` in tansy.config.ts. */
    url: string;
    /** The pull zone's URL token authentication key, under Security → Token Authentication. */
    tokenKey: string;
  };
  /** A folder holding every key, to keep several sites in one zone. */
  prefix?: string;
  /** Needed only when two zones are in use at once, such as during a move. */
  name?: string;
}

const PROVIDER = "Bunny Storage";
const ZONE = /^[A-Za-z0-9-]{1,64}$/;

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * Signs a pull zone URL with token authentication: an HMAC-SHA256 of the path, the expiry
 * and the sorted query parameters, so Bunny refuses it after `expires` or with any change.
 */
export function signBunnyUrl(url: URL, tokenKey: string, expires: number) {
  const params = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signing = params.map(([key, value]) => `${key}=${value}`).join("&");
  const token = createHmac("sha256", tokenKey).update(url.pathname).update(String(expires)).update(signing).digest("base64url");
  const query = params.map(([key, value]) => `&${key}=${encodeURIComponent(value)}`).join("");
  return `${url.origin}${url.pathname}?token=HS256-${token}${query}&expires=${expires}`;
}

/**
 * Bunny Optimizer's resize parameters. A ratio crops to it from the centre. `quality` makes
 * Bunny treat the file as an image although its key has no extension.
 */
export function bunnyResize({ width, height, fit }: Pick<ThumbnailOptions, "width" | "height" | "fit">): Record<string, string> {
  return { width: String(width), ...(fit === "cover" && height ? { aspect_ratio: `${width}:${height}` } : {}), quality: "80" };
}

/**
 * Bunny Storage, through its Edge Storage API. The storage API needs the zone's
 * password for every read, so files are served by the CMS after its access checks.
 * With `cdn`, thumbnails go to Bunny Optimizer through short-lived signed URLs.
 */
export function bunnyStorage(options: BunnyStorageOptions, fetcher: typeof fetch = fetch): StorageAdapter {
  const { storageZone, accessKey, region = "de", cdn, prefix = "", name = "bunny" } = options;
  const keyPrefix = prefix ? `${prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const zoneUrl = (path: string) => `https://${REGIONS[region]}/${storageZone}/${encodeKey(keyPrefix + path)}`;
  const call = (action: string, url: string, init?: ProviderCall) => callProvider(PROVIDER, action, url, { ...init, headers: { ...init?.headers, accesskey: accessKey } }, fetcher);

  /** Every file below a folder of the zone, as zone paths. */
  const walk = async (folder: string, found: StoredObject[]) => {
    const response = await call("list", `https://${REGIONS[region]}/${storageZone}/${encodeKey(folder)}`, { headers: { accept: "application/json" }, allow: [404] });
    if (response.status === 404) {
      await response.body?.cancel();
      return;
    }
    const entries = (await response.json()) as { ObjectName?: unknown; IsDirectory?: unknown; Length?: unknown }[];
    for (const { ObjectName: object, IsDirectory: directory, Length: length } of Array.isArray(entries) ? entries : []) {
      if (typeof object !== "string" || !object || object.includes("/")) continue;
      if (directory === true) await walk(`${folder}${object}/`, found);
      else found.push({ key: folder + object, size: Number(length) || 0 });
    }
  };

  const adapter: StorageAdapter = {
    name,

    assertUsable() {
      if (!ZONE.test(storageZone ?? "")) throw new Error("Bunny Storage needs the storage zone's name: letters, digits and -.");
      if (!accessKey) throw new Error("Bunny Storage needs the storage zone's password.");
      if (!(region in REGIONS)) throw new Error(`Bunny Storage's region must be one of ${Object.keys(REGIONS).join(", ")}.`);
      if (cdn) {
        const url = new URL(cdn.url);
        if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.username || url.password) throw new Error("Bunny's CDN url must be an https origin, such as https://example.b-cdn.net.");
        if (!cdn.tokenKey) throw new Error("Bunny's CDN needs its token authentication key, or anyone could read files from it.");
      }
    },

    async put(key, body, { size }) {
      const response = await call("upload", zoneUrl(key), {
        method: "PUT",
        // Bunny serves a stored file with the type its name suggests, and these keys have none.
        headers: { "content-type": "application/octet-stream", "content-length": String(size) },
        body,
      });
      await response.body?.cancel();
    },

    async get(key, range) {
      const response = await call("read", zoneUrl(key), { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {}, allow: [404] });
      if (response.status === 404 || !response.body) {
        await response.body?.cancel();
        return null;
      }
      return rangeOf(response, range);
    },

    async delete(key) {
      const response = await call("delete", zoneUrl(key), { method: "DELETE", allow: [404] });
      await response.body?.cancel();
    },

    async list(listPrefix) {
      const full = keyPrefix + listPrefix;
      const found: StoredObject[] = [];
      // Bunny lists one folder at a time, so the walk starts at the prefix's folder.
      await walk(full.slice(0, full.lastIndexOf("/") + 1), found);
      return found.filter(({ key }) => key.startsWith(full)).map(({ key, size }) => ({ key: key.slice(keyPrefix.length), size }));
    },
  };

  if (cdn) {
    adapter.thumbnailUrl = async (key, thumbnail) => {
      const url = new URL(`${new URL(cdn.url).origin}/${encodeKey(keyPrefix + key)}`);
      for (const [param, value] of Object.entries(bunnyResize(thumbnail))) url.searchParams.set(param, value);
      return signBunnyUrl(url, cdn.tokenKey, Math.floor(Date.now() / 1000) + thumbnail.expiresIn);
    };
    Object.assign(adapter, { thumbnailUrlsExpire: true });
  }
  return adapter;
}
