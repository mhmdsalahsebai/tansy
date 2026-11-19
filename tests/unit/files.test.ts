import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { streamFiles, type BlockCatalog } from "@/core/blocks/stream";
import { contentDisposition, parseRange, safeFileName } from "@/core/files/http";
import { detectType, servesInline, typeAllowed } from "@/core/files/sniff";
import { createFileToken, FILE_TOKEN_TTL_SECONDS, verifyFileToken } from "@/core/files/tokens";
import { diffFields } from "@/core/schema/diff";
import { adapterNamed, assertStorageUsable, maxUploadBytes, uploadAdapter } from "@/core/storage";
import { localStorage } from "@/core/storage/local";
import { s3Storage } from "@/core/storage/s3";
import type { StorageAdapter } from "@/core/storage/types";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const streamOf = (value: string) => new Blob([value]).stream();
const read = async (stream: ReadableStream<Uint8Array> | null) => new Response(stream).text();

describe("detectType", () => {
  it("recognises formats from their bytes", () => {
    expect(detectType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(detectType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectType(text("GIF89a...."))).toBe("image/gif");
    expect(detectType(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(detectType(text("\0\0\0\x20ftypavif"))).toBe("image/avif");
    expect(detectType(text("\0\0\0\x20ftypisom"))).toBe("video/mp4");
    expect(detectType(text("%PDF-1.7"))).toBe("application/pdf");
  });
  it("ignores a client's claim about binary and markup files", () => {
    expect(detectType(text("<html><script>alert(1)</script>"), "image/png")).toBe("text/html");
    expect(detectType(text("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png")).toBe("image/svg+xml");
    expect(detectType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "text/html")).toBe("image/png");
    expect(detectType(bytes(0, 1, 2, 3), "image/png")).toBe("application/octet-stream");
  });
  it("finds markup behind a BOM, whitespace, prologs and comments", () => {
    expect(detectType(text("\uFEFF  <?xml version='1.0'?><!-- x --><SVG>"))).toBe("image/svg+xml");
    expect(detectType(text("<!-- a --><!DOCTYPE HTML><p>"))).toBe("text/html");
  });
  it("uses the claim only to choose among look-alike formats", () => {
    expect(detectType(text("a,b\n1,2"), "text/csv; charset=utf-8")).toBe("text/csv");
    expect(detectType(text("just words"), "image/png")).toBe("text/plain");
    expect(detectType(text("just words"), "text/html")).toBe("text/plain");
    const zip = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(detectType(zip, "application/epub+zip")).toBe("application/epub+zip");
    expect(detectType(zip, "text/html")).toBe("application/zip");
  });
});

describe("type rules", () => {
  it("never serve active content inline", () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf", "text/plain", "application/octet-stream"]) expect(servesInline(type), type).toBe(false);
    for (const type of ["image/png", "video/mp4", "audio/mpeg"]) expect(servesInline(type), type).toBe(true);
  });
  it("match field allow lists, with image/* excluding SVG", () => {
    expect(typeAllowed("image/png", undefined)).toBe(true);
    expect(typeAllowed("image/png", ["image/*"])).toBe(true);
    expect(typeAllowed("image/svg+xml", ["image/*"])).toBe(false);
    expect(typeAllowed("image/svg+xml", ["image/svg+xml"])).toBe(true);
    expect(typeAllowed("video/mp4", ["video/*"])).toBe(true);
    expect(typeAllowed("application/pdf", ["image/*", "video/*"])).toBe(false);
  });
});

describe("file names and headers", () => {
  it("drop paths and control characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\temp\\a.png")).toBe("a.png");
    expect(safeFileName("a\r\nSet-Cookie: x.png")).toBe("aSet-Cookie: x.png");
    expect(safeFileName("   ")).toBe("file");
  });
  it("can't break out of Content-Disposition", () => {
    const header = contentDisposition('a"; filename="evil.html', "text/html");
    expect(header.startsWith('attachment; filename="a_; filename=_evil.html"')).toBe(true);
    expect(contentDisposition("caf\u00e9.png", "image/png")).toBe(`inline; filename="caf_.png"; filename*=UTF-8''caf%C3%A9.png`);
  });
  it("parse byte ranges", () => {
    expect(parseRange(null, 10)).toBeUndefined();
    expect(parseRange("bytes=0-4", 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=0-999", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,3-4", 10)).toBeUndefined();
    expect(parseRange("nonsense", 10)).toBeUndefined();
  });
});

describe("file tokens", () => {
  it("work for one file until they expire", () => {
    const now = Date.now();
    const { token } = createFileToken("file-a", now);
    expect(verifyFileToken("file-a", token, now)).toBe(true);
    expect(verifyFileToken("file-b", token, now)).toBe(false);
    expect(verifyFileToken("file-a", token, now + (FILE_TOKEN_TTL_SECONDS + 1) * 1000)).toBe(false);
  });
  it("can't be forged or extended", () => {
    const { token } = createFileToken("file-a");
    const [expires, signature] = token.split(".");
    expect(verifyFileToken("file-a", `${Number(expires) + 1000}.${signature}`)).toBe(false);
    expect(verifyFileToken("file-a", `${expires}.${"A".repeat(43)}`)).toBe(false);
    for (const bad of [undefined, "", "x", "1.2.3"]) expect(verifyFileToken("file-a", bad)).toBe(false);
  });
});

describe("local storage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cms-local-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());
  const adapter = localStorage({ dir });
  const put = { size: 5, contentType: "text/plain" };

  it("stores, reads ranges and deletes", async () => {
    await adapter.put("a/b/one", streamOf("hello"), put);
    expect(await read(await adapter.get("a/b/one"))).toBe("hello");
    expect(await read(await adapter.get("a/b/one", { start: 1, end: 3 }))).toBe("ell");
    await adapter.delete("a/b/one");
    expect(await adapter.get("a/b/one")).toBeNull();
    await adapter.delete("a/b/one");
  });
  it("leaves no partial file when a write fails", async () => {
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(text("par")); controller.error(new Error("connection lost")); } });
    await expect(adapter.put("failed/partial", broken, put)).rejects.toThrow();
    expect(readdirSync(path.join(dir, "failed"))).toEqual([]);
  });
  it("refuses keys outside its directory", async () => {
    await expect(adapter.put("../escape", streamOf("x"), put)).rejects.toThrow(/outside/);
    await expect(adapter.get("../../etc/passwd")).rejects.toThrow(/outside/);
  });
  it("offers no signed URLs, so reads always pass the access checks", () => {
    expect(adapter.signedUrl).toBeUndefined();
  });
  it("is refused in production unless explicitly allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertStorageUsable({ adapter })).toThrow(/for development/);
    expect(() => uploadAdapter({ adapter })).toThrow(/not available/);
    expect(() => assertStorageUsable({ adapter: s3Storage({ endpoint: "https://x.test", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }), previous: [adapter] })).toThrow(/for development/);
    expect(() => assertStorageUsable({ adapter: localStorage({ dir, allowInProduction: true }) })).not.toThrow();
  });
  it("is accepted in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertStorageUsable({ adapter })).not.toThrow();
  });
  it("refuses a directory the web server would serve", () => {
    expect(() => localStorage({ dir: "public/uploads" }).assertUsable?.()).toThrow(/outside public/);
  });
});

describe("storage configuration", () => {
  const named = (name: string): StorageAdapter => ({ name, put: async () => {}, get: async () => null, delete: async () => {} });
  it("finds older adapters so files survive a move", () => {
    const [current, old] = [named("new"), named("old")];
    expect(adapterNamed("old", { adapter: current, previous: [old] })).toBe(old);
    expect(() => adapterNamed("gone", { adapter: current, previous: [old] })).toThrow(/not available/);
  });
  it("refuses duplicate names", () => {
    expect(() => assertStorageUsable({ adapter: named("a"), previous: [named("a")] })).toThrow(/unique/);
  });
  it("defaults the upload limit", () => {
    expect(maxUploadBytes({ adapter: named("a") })).toBe(50 * 1024 * 1024);
    expect(maxUploadBytes({ adapter: named("a"), maxUploadBytes: 10 })).toBe(10);
  });
  it("calls a plugin's own usability check", () => {
    const broken = { ...named("broken"), assertUsable() { throw new Error("no credentials"); } };
    expect(() => assertStorageUsable({ adapter: broken })).toThrow("no credentials");
  });
});

describe("S3-compatible storage", () => {
  const objects = new Map<string, { body: Buffer; type?: string }>();
  const seen: IncomingMessage[] = [];
  let server: Server, endpoint: string, failWith: number | null = null;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (failWith) { res.writeHead(failWith).end("<Error>SecretKeyDetail</Error>"); return; }
    const key = req.url!.split("?")[0];
    if (req.method === "PUT") { objects.set(key, { body: Buffer.concat(chunks), type: req.headers["content-type"] }); res.writeHead(200).end(); return; }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204).end(); return; }
    const object = objects.get(key);
    if (!object) { res.writeHead(404).end("<Error/>"); return; }
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    res.writeHead(range ? 206 : 200).end(range ? object.body.subarray(Number(range[1]), Number(range[2]) + 1) : object.body);
  };

  beforeAll(async () => {
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  afterEach(() => { failWith = null; seen.length = 0; });

  const adapter = () => s3Storage({ endpoint, bucket: "media", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG", region: "us-east-1" });

  it("uploads a stream with a declared length and a signature", async () => {
    await adapter().put("files/ab/one", streamOf("hello"), { size: 5, contentType: "text/plain" });
    const request = seen[0];
    expect(request.url).toBe("/media/files/ab/one");
    expect(request.headers["content-length"]).toBe("5");
    expect(request.headers["transfer-encoding"]).toBeUndefined();
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d+\/us-east-1\/s3\/aws4_request/);
    expect(objects.get("/media/files/ab/one")!.body.toString()).toBe("hello");
    expect(objects.get("/media/files/ab/one")!.type).toBe("text/plain");
  });
  it("reads objects and ranges, with null for a missing one", async () => {
    await adapter().put("two", streamOf("abcdef"), { size: 6, contentType: "text/plain" });
    expect(await read(await adapter().get("two"))).toBe("abcdef");
    expect(await read(await adapter().get("two", { start: 1, end: 2 }))).toBe("bc");
    expect(await adapter().get("missing")).toBeNull();
  });
  it("treats deleting a missing object as success", async () => {
    await adapter().delete("nothing-here");
  });
  it("keeps provider responses out of errors", async () => {
    failWith = 403;
    await expect(adapter().get("x")).rejects.toThrow("S3 read failed with status 403.");
    await expect(adapter().put("x", streamOf("a"), { size: 1, contentType: "text/plain" })).rejects.not.toThrow(/SecretKeyDetail/);
  });
  it("signs short-lived download URLs that fix the served headers", async () => {
    const url = new URL(await adapter().signedUrl!("files/one", { expiresIn: 300, contentType: "image/png", disposition: 'inline; filename="a.png"' }));
    expect(url.pathname).toBe("/media/files/one");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("response-content-disposition")).toBe('inline; filename="a.png"');
    expect(url.toString()).not.toContain("wJalrXUtnFEMI");
  });
  it("supports prefixes and virtual-hosted buckets", async () => {
    const prefixed = s3Storage({ endpoint, bucket: "media", accessKeyId: "a", secretAccessKey: "s", prefix: "site-one/" });
    await prefixed.put("k", streamOf("x"), { size: 1, contentType: "text/plain" });
    expect(seen[0].url).toBe("/media/site-one/k");
    const hosted = await s3Storage({ endpoint: "https://s3.example.test", bucket: "media", accessKeyId: "a", secretAccessKey: "s", pathStyle: false }).signedUrl!("k", { expiresIn: 60, contentType: "a/b", disposition: "inline" });
    expect(new URL(hosted).hostname).toBe("media.s3.example.test");
    expect(new URL(hosted).pathname).toBe("/k");
  });
  it("reports missing settings at startup, not during a build", () => {
    const incomplete = s3Storage({ endpoint, bucket: "media", accessKeyId: "", secretAccessKey: "" });
    expect(() => incomplete.assertUsable?.()).toThrow(/accessKeyId, secretAccessKey/);
  });
});

describe("files in schemas and blocks", () => {
  const stored = (type: string) => ({ id: 1, name: "f", type, config: {} });
  it("only convert between single-file types", () => {
    expect(diffFields([stored("image")], [{ id: 1, name: "f", type: "file" }]).issues).toEqual([]);
    for (const [from, to] of [["file", "text"], ["text", "file"], ["file", "gallery"], ["gallery", "json"]]) {
      expect(diffFields([stored(from)], [{ id: 1, name: "f", type: to }]).issues.length, `${from} to ${to}`).toBe(1);
    }
  });
  it("find files at any depth, and leave unreadable blocks alone", () => {
    const fields = [{ name: "photo", type: "image", config: {} }, { name: "more", type: "gallery", config: {} }, { name: "inner", type: "stream", config: {} }];
    const catalog: BlockCatalog = new Map([["card", { name: "card", version: 1, fields }]]);
    const { files, opaque } = streamFiles([
      { id: "a", type: "card", v: 1, value: { photo: "one", more: ["two", "three"], inner: [{ id: "b", type: "card", v: 1, value: { photo: "four" } }] } },
      { id: "old", type: "card", v: 9, value: { photo: "five", inner: [{ id: "nested", type: "x", v: 1, value: {} }] } },
    ], catalog);
    expect(files.map((f) => [f.blockId, f.field.name, f.fileIds])).toEqual([["a", "photo", ["one"]], ["a", "more", ["two", "three"]], ["b", "photo", ["four"]]]);
    expect([...opaque].sort()).toEqual(["nested", "old"]);
  });
});

