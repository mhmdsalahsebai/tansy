import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredFile } from "../../packages/cms/generated/client-sqlite";
import { serveFile } from "@/core/files/service";
import { callProvider, rangeOf, StorageProviderError } from "@/core/storage/remote";
import type { StorageAdapter } from "@/core/storage/types";
import { bunnyResize, bunnyStorage, signBunnyUrl } from "../../plugins/storage-bunny/index";
import { cloudinaryStorage, cloudinaryTransformation } from "../../plugins/storage-cloudinary/index";
import { uploadthingStorage, type UploadthingClient } from "../../plugins/storage-uploadthing/index";
import { vercelBlobStorage } from "../../plugins/storage-vercel-blob/index";

const storage = vi.hoisted(() => ({ adapter: undefined as StorageAdapter | undefined }));
vi.mock("@/core/storage", async (original) => ({ ...(await original<object>()), adapterNamed: () => storage.adapter }));

interface Sent { method: string; url: URL; headers: Headers; body: RequestInit["body"] }

/** A fetch that records each request and answers from `reply`. */
function provider(reply: (request: Sent) => Response = () => new Response(null)) {
  const sent: Sent[] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    expect(init.redirect).toBe("error");
    const request = { method: init.method ?? "GET", url: new URL(String(input)), headers: new Headers(init.headers), body: init.body };
    sent.push(request);
    return reply(request);
  }) as typeof fetch;
  return { sent, fetcher };
}

const stream = (text: string) => new Blob([text]).stream();
const text = (body: ReadableStream<Uint8Array> | null) => new Response(body).text();
/** Several chunks, so slicing crosses their edges. */
const chunked = (...parts: string[]) => new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }));

describe("provider helpers", () => {
  it("report only the status, never what the provider said", async () => {
    const { fetcher } = provider(() => new Response("SignatureDoesNotMatch for secret abc123", { status: 403 }));
    const error = await callProvider("Bunny Storage", "read", "https://a.example/x", {}, fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageProviderError);
    expect(String(error)).toBe("StorageProviderError: Bunny Storage read failed with status 403.");
    expect(String(error)).not.toContain("abc123");
  });
  it("say an unreachable provider is unreachable, without the address", async () => {
    const fetcher = (async () => { throw new TypeError("fetch failed: https://key@a.example"); }) as typeof fetch;
    await expect(callProvider("Vercel Blob", "upload", "https://a.example", {}, fetcher)).rejects.toThrow("Vercel Blob couldn't be reached to upload.");
  });
  it("cut a full answer down to the requested bytes", async () => {
    expect(await text(rangeOf(chunked("0123", "4567", "89"), { start: 3, end: 6 }))).toBe("3456");
    expect(await text(rangeOf(chunked("0123", "4567"), { start: 6, end: 20 }))).toBe("67");
    expect(await text(rangeOf(chunked("abc"), undefined))).toBe("abc");
  });
  it("trust an answer that is already partial", async () => {
    expect(await text(rangeOf(new Response("cde", { status: 206 }), { start: 2, end: 4 }))).toBe("cde");
  });
});

describe("Cloudinary", () => {
  const options = { cloudName: "demo", apiKey: "key", apiSecret: "secret", prefix: "site" };
  const signature = (params: Record<string, string>) => createHash("sha1").update(Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&") + "secret").digest("hex");

  it("refuses a cloud name that could point elsewhere", () => {
    expect(() => cloudinaryStorage({ ...options, cloudName: "evil.example/x" }).assertUsable!()).toThrow();
    expect(() => cloudinaryStorage({ ...options, apiSecret: "" }).assertUsable!()).toThrow("apiSecret");
  });

  it("uploads images as images and everything else raw, signed and private", async () => {
    const { sent, fetcher } = provider(() => Response.json({}));
    const adapter = cloudinaryStorage(options, fetcher);
    await adapter.put("files/ab/one", stream("png"), { size: 3, contentType: "image/png" });
    await adapter.put("backups/two.tar.gz", stream("tar"), { size: 3, contentType: "application/gzip" });
    expect(sent.map(({ url }) => url.pathname)).toEqual(["/v1_1/demo/image/upload", "/v1_1/demo/raw/upload"]);
    const form = sent[0].body as FormData;
    expect(form.get("public_id")).toBe("site/files/ab/one");
    expect(form.get("type")).toBe("authenticated");
    expect(await (form.get("file") as Blob).text()).toBe("png");
    const signed = Object.fromEntries(["invalidate", "overwrite", "public_id", "timestamp", "type"].map((key) => [key, String(form.get(key))]));
    expect(form.get("signature")).toBe(signature(signed));
    expect(form.get("api_key")).toBe("key");
  });

  it("reads an image or a raw file through the signed download API", async () => {
    const { sent, fetcher } = provider(({ url }) => (url.pathname.includes("/image/") ? new Response("gone", { status: 404 }) : new Response("0123456789")));
    const body = await cloudinaryStorage(options, fetcher).get("backups/two", { start: 2, end: 4 });
    expect(await text(body)).toBe("234");
    expect(sent.map(({ url }) => url.pathname)).toEqual(["/v1_1/demo/image/download", "/v1_1/demo/raw/download"]);
    expect(sent[1].url.searchParams.get("public_id")).toBe("site/backups/two");
    expect(sent[1].headers.get("range")).toBe("bytes=2-4");
  });

  it("returns null for a file in neither kind", async () => {
    const { fetcher } = provider(() => new Response(null, { status: 404 }));
    expect(await cloudinaryStorage(options, fetcher).get("files/ab/none")).toBeNull();
  });

  it("lists both kinds page by page, without its folder", async () => {
    const { sent, fetcher } = provider(({ url }) => {
      if (url.pathname.includes("/image/")) return Response.json(url.searchParams.get("next_cursor") ? { resources: [{ public_id: "site/backups/b", bytes: 2 }] } : { resources: [{ public_id: "site/backups/a", bytes: 1 }], next_cursor: "n" });
      return Response.json({ resources: [{ public_id: "site/backups/c.tar", bytes: 3 }] });
    });
    expect(await cloudinaryStorage(options, fetcher).list!("backups/")).toEqual([{ key: "backups/a", size: 1 }, { key: "backups/b", size: 2 }, { key: "backups/c.tar", size: 3 }]);
    expect(sent[0].url.searchParams.get("prefix")).toBe("site/backups/");
    expect(sent[0].headers.get("authorization")).toBe(`Basic ${Buffer.from("key:secret").toString("base64")}`);
  });

  it("deletes from both kinds", async () => {
    const { sent, fetcher } = provider(() => Response.json({ result: "not found" }));
    await cloudinaryStorage(options, fetcher).delete("files/ab/one");
    expect(sent.map(({ url }) => url.pathname)).toEqual(["/v1_1/demo/image/destroy", "/v1_1/demo/raw/destroy"]);
  });

  it("signs thumbnail URLs, which don't expire, so core keeps them on the server", async () => {
    const adapter = cloudinaryStorage(options);
    expect(adapter.thumbnailUrlsExpire).toBeFalsy();
    const url = await adapter.thumbnailUrl!("files/ab/one", { width: 300, height: 300, fit: "cover", expiresIn: 300 });
    const transformation = "c_lfill,h_300,w_300,f_webp,q_80";
    const expected = createHash("sha1").update(`${transformation}/site/files/ab/one` + "secret").digest("base64").slice(0, 8).replace(/\//g, "_").replace(/\+/g, "-");
    expect(url).toBe(`https://res.cloudinary.com/demo/image/authenticated/s--${expected}--/${transformation}/v1/site/files/ab/one`);
    expect(cloudinaryTransformation({ width: 800, fit: "inside" })).toBe("c_limit,w_800,f_webp,q_80");
  });
});

describe("Vercel Blob", () => {
  const token = "vercel_blob_rw_store123_secretABC";

  it("needs a read-write token it can find the store in", () => {
    expect(() => vercelBlobStorage({ token: "" }).assertUsable!()).toThrow();
    expect(() => vercelBlobStorage({ token: "vercel_blob_rw_x.evil.example/_s" }).assertUsable!()).toThrow();
    expect(() => vercelBlobStorage({ token }).assertUsable!()).not.toThrow();
  });

  it("uploads private, at the key, replacing what's there", async () => {
    const { sent, fetcher } = provider(() => Response.json({}));
    await vercelBlobStorage({ token, prefix: "site" }, fetcher).put("files/ab/one", stream("abc"), { size: 3, contentType: "image/png" });
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].url.href).toBe("https://vercel.com/api/blob/?pathname=site%2Ffiles%2Fab%2Fone");
    expect(Object.fromEntries(["authorization", "x-vercel-blob-access", "x-add-random-suffix", "x-allow-overwrite", "x-content-type"].map((name) => [name, sent[0].headers.get(name)]))).toEqual({
      authorization: `Bearer ${token}`, "x-vercel-blob-access": "private", "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-content-type": "image/png",
    });
  });

  it("reads from the private store with the token, and null when missing", async () => {
    const { sent, fetcher } = provider(({ url }) => (url.pathname.endsWith("/none") ? new Response(null, { status: 404 }) : new Response("hello")));
    const adapter = vercelBlobStorage({ token }, fetcher);
    expect(await text(await adapter.get("files/ab/one"))).toBe("hello");
    expect(sent[0].url.href).toBe("https://store123.private.blob.vercel-storage.com/files/ab/one");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(await adapter.get("files/ab/none")).toBeNull();
  });

  it("deletes by URL and lists every page", async () => {
    const { sent, fetcher } = provider(({ url }) => (url.searchParams.get("cursor") ? Response.json({ blobs: [{ pathname: "site/backups/b", size: 2 }], hasMore: false }) : Response.json({ blobs: [{ pathname: "site/backups/a", size: 1 }], hasMore: true, cursor: "c1" })));
    const adapter = vercelBlobStorage({ token, prefix: "site" }, fetcher);
    await adapter.delete("files/ab/one");
    expect(JSON.parse(String(sent[0].body))).toEqual({ urls: ["https://store123.private.blob.vercel-storage.com/site/files/ab/one"] });
    expect(await adapter.list!("backups/")).toEqual([{ key: "backups/a", size: 1 }, { key: "backups/b", size: 2 }]);
  });

  it("offers no signed URLs, which couldn't set a download's name", () => {
    expect(vercelBlobStorage({ token }).signedUrl).toBeUndefined();
  });
});

describe("Bunny", () => {
  const options = { storageZone: "my-zone", accessKey: "zone-password", prefix: "site" };

  it("checks its zone, region and CDN", () => {
    expect(() => bunnyStorage({ ...options, storageZone: "a.evil.example/x" }).assertUsable!()).toThrow();
    expect(() => bunnyStorage({ ...options, region: "mars" as "de" }).assertUsable!()).toThrow();
    expect(() => bunnyStorage({ ...options, cdn: { url: "https://example.b-cdn.net", tokenKey: "" } }).assertUsable!()).toThrow("token");
    expect(() => bunnyStorage({ ...options, cdn: { url: "http://example.b-cdn.net", tokenKey: "t" } }).assertUsable!()).toThrow();
    expect(() => bunnyStorage({ ...options, region: "ny", cdn: { url: "https://example.b-cdn.net", tokenKey: "t" } }).assertUsable!()).not.toThrow();
  });

  it("uploads, reads and deletes with the zone's password in its region", async () => {
    const { sent, fetcher } = provider(({ method }) => (method === "GET" ? new Response("abcdef") : new Response(null, { status: method === "DELETE" ? 404 : 201 })));
    const adapter = bunnyStorage({ ...options, region: "uk" }, fetcher);
    await adapter.put("files/ab/one", stream("abc"), { size: 3, contentType: "text/html" });
    expect(await text(await adapter.get("files/ab/one", { start: 1, end: 2 }))).toBe("bc");
    await adapter.delete("files/ab/one");
    expect(sent.map(({ method, url }) => `${method} ${url.href}`)).toEqual(Array(3).fill("").map((_, index) => `${["PUT", "GET", "DELETE"][index]} https://uk.storage.bunnycdn.com/my-zone/site/files/ab/one`));
    expect(sent.every(({ headers }) => headers.get("accesskey") === "zone-password")).toBe(true);
    // Never the declared type, which Bunny could serve from the pull zone.
    expect(sent[0].headers.get("content-type")).toBe("application/octet-stream");
  });

  it("lists by walking folders below the prefix", async () => {
    const { sent, fetcher } = provider(({ url }) => {
      if (url.pathname === "/my-zone/site/backups/") return Response.json([{ ObjectName: "a", IsDirectory: false, Length: 1 }, { ObjectName: "old", IsDirectory: true }]);
      if (url.pathname === "/my-zone/site/backups/old/") return Response.json([{ ObjectName: "b", IsDirectory: false, Length: 2 }]);
      return new Response(null, { status: 404 });
    });
    expect(await bunnyStorage(options, fetcher).list!("backups/")).toEqual([{ key: "backups/a", size: 1 }, { key: "backups/old/b", size: 2 }]);
    expect(sent.map(({ url }) => url.pathname)).toEqual(["/my-zone/site/backups/", "/my-zone/site/backups/old/"]);
  });

  it("makes thumbnails only with a token-protected CDN", async () => {
    expect(bunnyStorage(options).thumbnailUrl).toBeUndefined();
    const adapter = bunnyStorage({ ...options, cdn: { url: "https://example.b-cdn.net", tokenKey: "token-key" } });
    expect(adapter.thumbnailUrlsExpire).toBe(true);
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const url = new URL(await adapter.thumbnailUrl!("files/ab/one", { width: 300, height: 200, fit: "cover", expiresIn: 300 }));
    vi.useRealTimers();
    expect(url.origin + url.pathname).toBe("https://example.b-cdn.net/site/files/ab/one");
    expect(url.searchParams.get("expires")).toBe(String(1_700_000_000 + 300));
    const expected = createHmac("sha256", "token-key").update("/site/files/ab/one").update("1700000300").update("aspect_ratio=300:200&quality=80&width=300").digest("base64url");
    expect(url.searchParams.get("token")).toBe(`HS256-${expected}`);
    expect(bunnyResize({ width: 800, fit: "inside" })).toEqual({ width: "800", quality: "80" });
  });

  it("signs every parameter, so none can be changed", () => {
    const signed = (width: string) => new URL(signBunnyUrl(new URL(`https://a.b-cdn.net/k?width=${width}`), "key", 100)).searchParams.get("token");
    expect(signed("100")).not.toBe(signed("4000"));
  });
});

describe("Uploadthing", () => {
  function client(files: { customId: string; size: number; status?: string }[] = []) {
    const calls: unknown[][] = [];
    const fake = {
      deleteFiles: vi.fn(async (...args: unknown[]) => { calls.push(["delete", ...args]); return { success: true, deletedCount: 0 }; }),
      uploadFiles: vi.fn(async (...args: unknown[]) => { calls.push(["upload", ...args]); return { data: {}, error: null }; }),
      getSignedURL: vi.fn(async (key: string) => {
        if (!files.some((file) => file.customId === key)) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND" });
        return { url: "", ufsUrl: `https://app.ufs.sh/f/${encodeURIComponent(key)}?signature=x` };
      }),
      listFiles: vi.fn(async ({ offset = 0 }: { offset?: number } = {}) => ({
        hasMore: offset === 0 && files.length > 1,
        files: (offset === 0 ? files.slice(0, 1) : files.slice(1)).map((file, index) => ({ id: String(index), key: `k${index}`, name: "f", uploadedAt: 0, customId: file.customId, size: file.size, status: file.status ?? "Uploaded" })),
      })),
    };
    return { calls, fake: fake as unknown as UploadthingClient & typeof fake };
  }

  it("replaces an object under core's key, private", async () => {
    const { calls, fake } = client();
    await uploadthingStorage({ token: "t", prefix: "site" }, fake).put("files/ab/one", stream("abc"), { size: 3, contentType: "image/png" });
    expect(calls.map(([kind]) => kind)).toEqual(["delete", "upload"]);
    expect(calls[0].slice(1)).toEqual(["site/files/ab/one", { keyType: "customId" }]);
    const [, file, uploadOptions] = calls[1] as [string, File & { customId: string }, unknown];
    expect(file.customId).toBe("site/files/ab/one");
    expect(await file.text()).toBe("abc");
    expect(uploadOptions).toEqual({ acl: "private", contentDisposition: "attachment" });
  });

  it("reads through a signed URL it fetches itself", async () => {
    const { fake } = client([{ customId: "files/ab/one", size: 6 }]);
    const { sent, fetcher } = provider(() => new Response("abcdef"));
    const adapter = uploadthingStorage({ token: "t" }, fake, fetcher);
    expect(await text(await adapter.get("files/ab/one", { start: 2, end: 3 }))).toBe("cd");
    expect(sent[0].headers.get("range")).toBe("bytes=2-3");
    expect(await adapter.get("files/ab/none")).toBeNull();
  });

  it("hides the SDK's errors, which can carry the request", async () => {
    const { fake } = client();
    fake.deleteFiles.mockRejectedValueOnce(new Error("401 for token eyJhcGlLZXkiOiJza19saXZlIn0"));
    await expect(uploadthingStorage({ token: "t" }, fake).delete("files/ab/one")).rejects.toThrow("Uploadthing couldn't be reached to delete.");
  });

  it("lists finished uploads under the prefix, page by page", async () => {
    const { fake } = client([{ customId: "site/backups/a", size: 1 }, { customId: "site/backups/b", size: 2 }, { customId: "site/backups/c", size: 3, status: "Uploading" }]);
    expect(await uploadthingStorage({ token: "t", prefix: "site" }, fake).list!("backups/")).toEqual([{ key: "backups/a", size: 1 }, { key: "backups/b", size: 2 }]);
  });
});

describe("thumbnails from the provider", () => {
  const file = { id: "f".repeat(22), key: "files/ff/x", storage: "cdn", name: "photo.png", type: "image/png", size: 10, width: 10, height: 10 } as StoredFile;
  const adapter = (extra: Partial<StorageAdapter>): StorageAdapter => ({
    name: "cdn",
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    thumbnailUrl: vi.fn(async (key, options) => `https://cdn.example/${key}?w=${options.width}&h=${options.height ?? ""}&fit=${options.fit}&e=${options.expiresIn}`),
    ...extra,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    storage.adapter = undefined;
  });

  it("send clients to a URL that expires, rendering and storing nothing", async () => {
    storage.adapter = adapter({ thumbnailUrlsExpire: true });
    const response = await serveFile(file, { thumb: "300x300", range: null });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://cdn.example/files/ff/x?w=300&h=300&fit=cover&e=300");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(storage.adapter.get).not.toHaveBeenCalled();
    expect(storage.adapter.put).not.toHaveBeenCalled();
  });

  it("fetch a URL that doesn't expire on the server, and pass on only an image", async () => {
    const fetcher = vi.fn(async () => new Response("webp-bytes", { headers: { "content-type": "image/webp" } }));
    vi.stubGlobal("fetch", fetcher);
    storage.adapter = adapter({});
    const response = await serveFile(file, { thumb: "800x0", range: null });
    expect(fetcher).toHaveBeenCalledWith("https://cdn.example/files/ff/x?w=800&h=&fit=inside&e=300", expect.objectContaining({ redirect: "error" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("webp-bytes");
    expect(storage.adapter.put).not.toHaveBeenCalled();
  });

  it("refuse whatever else the provider sends", async () => {
    storage.adapter = adapter({});
    vi.stubGlobal("fetch", async () => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }));
    await expect(serveFile(file, { thumb: "100x100", range: null })).rejects.toMatchObject({ status: 422 });
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    await expect(serveFile(file, { thumb: "100x100", range: null })).rejects.toMatchObject({ status: 422 });
  });
});
