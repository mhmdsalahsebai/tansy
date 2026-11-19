import "server-only";
import { withLocale } from "../i18n/storage";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StoredFile } from "../../generated/client-sqlite";
import sharp from "sharp";
import type { Principal } from "../authz/principal";
import { loadRuleLookups, type RuleLookups } from "../authz/records";
import { allCollections, type CollectionWithFields } from "../content/access";
import { findRecordsById } from "../content/content-service";
import { flattenRecord, readableFields } from "../content/records";
import { badRequest, HttpError, notFound } from "../http/errors";
import { adapterNamed, maxUploadBytes, uploadAdapter } from "../storage";
import type { ByteStream, StorageAdapter } from "../storage/types";
import prisma from "../../lib/prisma";
import { emitEvent } from "../extend/events";
import { isPostgres } from "../../lib/prisma/kind";
import { currentScopeValue } from "../scope/context";
import { assertStorageRoom } from "../scope/limits";
import { contentDisposition, parseRange, safeFileName } from "./http";
import { fileTextColumns, fileTextIn, type FileText } from "./text";
import { detectType, RASTER_IMAGES, SNIFF_BYTES } from "./sniff";
import { clampPercent, fileFocusOf, focusCrop, focusKeyPart, type FileFocus } from "./focus";
import { invalidateSiteCache } from "../site/cache";

export const THUMB_SIZES = ["100x100", "300x300", "800x0"] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

const SIGNED_URL_SECONDS = 300;
/** A thumbnail from a provider is refused past this, since it is held in memory. */
const MAX_PROVIDER_THUMB_BYTES = 10 * 1024 * 1024;
const PROVIDER_THUMB_TIMEOUT_MS = 30_000;
/** Bounds the memory one thumbnail can take, whatever a small file claims to decode to. */
const MAX_THUMB_PIXELS = 100_000_000;
/** How many records are checked before a file is refused. Refusing is the safe answer past this. */
const MAX_REFS_CHECKED = 1000;

const FILE_ID = /^[\w-]{22}$/;

const fileSummary = ({ id, name, type, size, createdById }: StoredFile) => ({ id, name, type, size, createdById });

/**
 * Files belong to the scope value they were uploaded in, such as a tenant, or to the instance
 * (an empty scope). Work for a value finds its own and the instance's, which every value shares.
 * Another value's file answers as missing, so its existence isn't revealed.
 */
export const fileScopeOf = () => currentScopeValue() ?? "";
export const findableFileScopes = () => [...new Set([fileScopeOf(), ""])];

export async function requireFile(id: string) {
  const file = FILE_ID.test(id) ? await prisma.storedFile.findFirst({ where: { id, scope: { in: findableFileScopes() } } }) : null;
  if (!file) throw notFound("File");
  return file;
}

/** `chain` is the language chain to read the file's text in, most wanted first (./text.ts). */
export const presentFile = (file: StoredFile, chain: readonly string[] = []) => {
  const { id, name, type, size, width, height, createdAt } = file;
  return { id, name, type, size, width, height, createdAt, ...fileTextIn(file, chain), focus: fileFocusOf(file) };
};

/** `search` narrows to files whose name contains it. Only the current scope value's own files, not the instance's. */
export async function listFiles(page: number, perPage: number, search?: string, chain: readonly string[] = []) {
  const scope = fileScopeOf();
  const where = search?.trim() ? { scope, name: { contains: search.trim() } } : { scope };
  const [totalItems, files] = await Promise.all([
    prisma.storedFile.count({ where }),
    prisma.storedFile.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * perPage, take: perPage, include: { _count: { select: { refs: true } } } }),
  ]);
  // Pending drafts count as use. They're few, and old history deliberately doesn't count.
  const drafts = (await prisma.revision.findMany({ where: { kind: "draft" }, select: { values: true } })).map((draft) => JSON.stringify(draft.values));
  return { page, perPage, totalItems, items: files.map((file) => ({ ...presentFile(file, chain), usedBy: file._count.refs + drafts.filter((draft) => draft.includes(file.id)).length })) };
}

const tooLarge = () => new HttpError(413, "PAYLOAD_TOO_LARGE", "This file is too large.");

async function receive(body: ByteStream, target: string, limit: number) {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > limit ? tooLarge() : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(target));
  return size;
}

async function readHead(file: string) {
  const handle = await open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function imageSize(file: string) {
  try {
    const metadata = await sharp(file, { limitInputPixels: false }).metadata();
    return { width: metadata.autoOrient?.width ?? metadata.width, height: metadata.autoOrient?.height ?? metadata.height };
  } catch {
    throw badRequest("This image could not be read.");
  }
}

interface Incoming {
  /** Where the bytes are on disk. Gone once `use` returns. */
  path: string;
  size: number;
  /** From the bytes themselves, never from the client's header alone. */
  type: string;
  dimensions: { width?: number; height?: number };
}

/**
 * Takes a request's raw body to a temp file and tells `run` what it is, so the type and size
 * are known before anything reaches storage and a large file never sits in memory. Both
 * uploading and replacing a file's bytes go through here, so neither can skip a check.
 */
async function receiveToTemp<T>(request: Request, run: (incoming: Incoming) => Promise<T>): Promise<T> {
  const limit = maxUploadBytes();
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw tooLarge();
  if (!request.body) throw badRequest("The file is empty.");

  const directory = await mkdtemp(path.join(tmpdir(), "cms-upload-"));
  const temp = path.join(directory, "upload");
  try {
    const size = await receive(request.body as ByteStream, temp, limit);
    if (size === 0) throw badRequest("The file is empty.");
    const type = detectType(await readHead(temp), request.headers.get("content-type"));
    const dimensions = RASTER_IMAGES.has(type) ? await imageSize(temp) : {};
    return await run({ path: temp, size, type, dimensions });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A key for new bytes. A scope value's files sit under their own prefix, so one value's bytes
 * can be found, exported and removed together. `suffix` gives replacement bytes a key of their
 * own, so nothing that cached the old key can serve them.
 */
function storageKey(id: string, scope: string, suffix = "") {
  const name = `${id}${suffix}`;
  return scope ? `files/${scope}/${id.slice(0, 2)}/${name}` : `files/${id.slice(0, 2)}/${name}`;
}

/** Written to a temp file first, so the type and size are known before anything reaches storage. */
export async function saveUpload(request: Request, rawName: string, createdById: string, temporary = false) {
  const adapter = uploadAdapter();
  return receiveToTemp(request, async ({ path: temp, size, type, dimensions }) => {
    // A scope value's limit on bytes of files (core/scope/limits.ts).
    await assertStorageRoom(size);
    const id = randomBytes(16).toString("base64url");
    const scope = fileScopeOf();
    const key = storageKey(id, scope);
    await adapter.put(key, Readable.toWeb(createReadStream(temp)) as ByteStream, { size, contentType: type });
    try {
      const stored = await prisma.storedFile.create({ data: { id, scope, storage: adapter.name, key, name: safeFileName(rawName), type, size, createdById, temporary, ...dimensions } });
      emitEvent("file.afterUpload", { file: fileSummary(stored) });
      return stored;
    } catch (error) {
      await adapter.delete(key).catch(() => {});
      throw error;
    }
  });
}

/**
 * Replaces a file's bytes under its own id, so every record, block and address that used it
 * now shows the new picture. The bytes go to a key of their own and the old ones are removed,
 * so nothing that holds the old key, or a URL signed for it, can serve what was replaced.
 *
 * The type may not change kind: a replacement is the same type, or another raster image for an
 * image, since a field, a thumbnail and a theme all expect what was there before. The focal
 * point is kept, being percentages, which hold for a picture of any size.
 */
export async function replaceFileBytes(file: StoredFile, request: Request) {
  const adapter = uploadAdapter();
  return receiveToTemp(request, async ({ path: temp, size, type, dimensions }) => {
    const bothImages = RASTER_IMAGES.has(type) && RASTER_IMAGES.has(file.type);
    if (type !== file.type && !bothImages) {
      throw new HttpError(409, "FILE_TYPE_CHANGED", `This file is ${file.type}, so its bytes can be replaced only by ${RASTER_IMAGES.has(file.type) ? "another image" : `another ${file.type}`}. Upload it as a new file instead.`);
    }
    // Only what it grows by: a value's limit is about what it holds, not what it uploads.
    if (size > file.size) await assertStorageRoom(size - file.size);

    const previous = { adapter: adapterNamed(file.storage), key: file.key, focus: fileFocusOf(file) };
    const key = storageKey(file.id, file.scope, `-r${randomBytes(4).toString("base64url")}`);
    await adapter.put(key, Readable.toWeb(createReadStream(temp)) as ByteStream, { size, contentType: type });
    let updated: StoredFile;
    try {
      updated = await prisma.storedFile.update({
        where: { id: file.id },
        data: { storage: adapter.name, key, type, size, width: dimensions.width ?? null, height: dimensions.height ?? null },
      });
    } catch (error) {
      await adapter.delete(key).catch(() => {});
      throw error;
    }

    // The row already points at the new bytes, so a failure here only leaves unreachable bytes behind.
    await discardBytes(previous.adapter, previous.key, previous.focus);
    // Pages hold the old width, height and type until their reads are read again.
    invalidateSiteCache();
    emitEvent("file.afterReplace", { file: fileSummary(updated) });
    return updated;
  });
}

/** The focal point is part of the key, so a new point is a new thumbnail rather than the old crop. */
const thumbKeyFor = (key: string, size: string, focus: FileFocus | null) => `thumbs/${key}/${size}${focusKeyPart(focus)}.webp`;
const thumbKey = (file: StoredFile, size: string, focus: FileFocus | null = fileFocusOf(file)) => thumbKeyFor(file.key, size, focus);

/** The bytes of a file at one key, with the thumbnails made from them. Failures are logged, never thrown. */
async function discardBytes(adapter: StorageAdapter, key: string, focus: FileFocus | null) {
  const keys = [key, ...THUMB_SIZES.flatMap((size) => [thumbKeyFor(key, size, null), ...(focus ? [thumbKeyFor(key, size, focus)] : [])])];
  const results = await Promise.allSettled(keys.map((one) => adapter.delete(one)));
  for (const result of results) if (result.status === "rejected") console.error(`[storage] could not delete bytes under ${key}`, result.reason);
}

/**
 * Sets, or clears, where the subject of a picture is. The thumbnails cropped for the old point
 * are removed, and the new point is part of the new thumbnails' keys, so nothing serves the old
 * crop. A browser that already holds one keeps it for as long as its cache says (five minutes).
 */
export async function setFileFocus(file: StoredFile, focus: FileFocus | null) {
  if (!RASTER_IMAGES.has(file.type)) throw badRequest("A focal point is for images only.");
  const previous = fileFocusOf(file);
  const updated = await prisma.storedFile.update({
    where: { id: file.id },
    data: focus ? { focusX: clampPercent(focus.x), focusY: clampPercent(focus.y) } : { focusX: null, focusY: null },
  });
  const adapter = adapterNamed(file.storage);
  const stale = await Promise.allSettled(THUMB_SIZES.map((size) => adapter.delete(thumbKey(file, size, previous))));
  for (const result of stale) if (result.status === "rejected") console.error(`[storage] could not delete a thumbnail of file ${file.id}`, result.reason);
  invalidateSiteCache();
  return updated;
}

/**
 * Files on a live record, a pending draft or a record in the trash are protected. Old
 * revisions don't protect a file, so it can still be removed for good, as Wagtail's purge
 * keeps only active revisions. Restoring such a revision then fails on that field.
 */
export async function deleteFile(file: StoredFile) {
  const adapter = adapterNamed(file.storage);
  try {
    await prisma.$transaction(async (tx) => {
      // Saves hold this row while attaching the file, so none can slip in between these checks and the delete.
      if (isPostgres()) await tx.$executeRaw`SELECT 1 FROM "StoredFile" WHERE "id" = ${file.id} FOR UPDATE`;
      if (await tx.fileRef.count({ where: { fileId: file.id } })) throw new HttpError(409, "CONFLICT", "Records still use this file. Remove it from them first.");
      const drafted = isPostgres()
        ? await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Revision" WHERE "kind" = 'draft' AND strpos("values"::text, ${file.id}) > 0 LIMIT 1`
        : await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Revision" WHERE "kind" = 'draft' AND instr("values", ${file.id}) > 0 LIMIT 1`;
      if (drafted.length) throw new HttpError(409, "CONFLICT", "A draft still uses this file. Publish or discard the draft first.");
      if (await tx.trashedFile.count({ where: { fileId: file.id } })) throw new HttpError(409, "CONFLICT", "A record in the trash still uses this file. Put that record back, or empty the trash, first.");
      await tx.storedFile.delete({ where: { id: file.id } });
    });
  } catch (error) {
    // A record attached it between the count and the delete.
    if ((error as { code?: string }).code === "P2003") throw new HttpError(409, "CONFLICT", "Records still use this file. Remove it from them first.");
    throw error;
  }
  // The file record is already gone, so a failure here only leaves unreachable bytes behind.
  await discardBytes(adapter, file.key, fileFocusOf(file));
  emitEvent("file.afterDelete", { file: fileSummary(file) });
}

/**
 * Whether anyone holding the permission, the uploader, or a viewer of a record
 * using the file may read it. `canView` must be decideRecord for this request.
 * Hidden fields don't count unless the caller may read them.
 */
export async function canReadFile(file: StoredFile, principal: Principal, canView: (collection: CollectionWithFields, record: Record<string, unknown>, lookups: RuleLookups) => boolean) {
  if (principal.permissions.has("file:read")) return true;
  if (principal.kind !== "anonymous" && file.createdById === principal.user.id) return true;

  const refs = await prisma.fileRef.findMany({ where: { fileId: file.id }, orderBy: { id: "asc" }, take: MAX_REFS_CHECKED, select: { sourceCollectionId: true, sourceRecordId: true, fieldId: true, locale: true } });
  if (!refs.length) return false;
  const collections = await allCollections();
  const lookups = await loadRuleLookups(collections.filter((collection) => refs.some((ref) => ref.sourceCollectionId === collection.id)));
  for (const collection of collections) {
    const readable = new Set(readableFields(collection, principal).map((field) => field.id));
    const mine = refs.filter((ref) => ref.sourceCollectionId === collection.id && readable.has(ref.fieldId));
    // A file in a localized field belongs to that language's translation alone, so a French draft's
    // files stay private while the English page is public. A shared field's follow the record.
    for (const locale of new Set(mine.map((ref) => ref.locale))) {
      const ids = mine.filter((ref) => ref.locale === locale).map((ref) => ref.sourceRecordId);
      const reading = locale ? withLocale(collection, { code: locale, chain: [locale], missing: "absent" }) : collection;
      for (const row of await findRecordsById(reading, [...new Set(ids)])) {
        if (canView(reading, flattenRecord(row), lookups)) return true;
      }
    }
  }
  return false;
}

async function bytesOf(stream: ByteStream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** "800x0" keeps the image's shape within 800 pixels wide. */
function thumbShape(size: ThumbSize) {
  const [width, height] = size.split("x").map(Number);
  return height ? { width, height, fit: "cover" as const } : { width, fit: "inside" as const };
}

const pendingThumbs = new Map<string, Promise<Buffer>>();

async function renderThumb(file: StoredFile, size: ThumbSize, adapter: StorageAdapter) {
  const key = thumbKey(file, size);
  const existing = await adapter.get(key);
  if (existing) return bytesOf(existing);

  if ((file.width ?? 0) * (file.height ?? 0) > MAX_THUMB_PIXELS) throw thumbFailed();
  const original = await adapter.get(file.key);
  if (!original) throw notFound("File");

  const { width, height, fit } = thumbShape(size);
  // A thumbnail that crops keeps the focal point. Without one nothing is extracted, so a file
  // that never had a focal point renders exactly the bytes it did before, under the same key.
  const focus = fileFocusOf(file);
  const crop = height && focus && file.width && file.height ? focusCrop({ width: file.width, height: file.height }, { width, height }, focus) : null;
  let output: Buffer;
  try {
    // `rotate` first, so a crop is in the same orientation as the width and height on the row.
    const image = sharp(await bytesOf(original), { limitInputPixels: MAX_THUMB_PIXELS }).rotate();
    output = await (crop ? image.extract(crop) : image)
      .resize({ width, height, fit, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw thumbFailed();
  }
  await adapter.put(key, new Blob([new Uint8Array(output)]).stream(), { size: output.length, contentType: "image/webp" });
  return output;
}

/** Made on first request and then kept. Concurrent requests share the work. */
function thumbnail(file: StoredFile, size: ThumbSize, adapter: StorageAdapter) {
  const key = thumbKey(file, size);
  let pending = pendingThumbs.get(key);
  if (!pending) {
    pending = renderThumb(file, size, adapter).finally(() => pendingThumbs.delete(key));
    pendingThumbs.set(key, pending);
  }
  return pending;
}

const thumbFailed = () => new HttpError(422, "THUMBNAIL_FAILED", "A thumbnail could not be made from this image.");

/** Reads at most `limit` bytes, or null past it. */
async function boundedBytes(stream: ByteStream, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) {
      await stream.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The provider's image service makes the thumbnail. A URL that expires goes to the client, as a
 * signed URL does. Any other is fetched here, so it never leaves the server.
 */
async function providerThumbnail(file: StoredFile, location: string, adapter: StorageAdapter) {
  if (adapter.thumbnailUrlsExpire) return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

  let response: Response;
  try {
    response = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(PROVIDER_THUMB_TIMEOUT_MS) });
  } catch {
    console.error(`[storage] ${adapter.name} could not be reached for a thumbnail of file ${file.id}`);
    throw thumbFailed();
  }
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  // Only a raster image is passed on, whatever the provider sends.
  const output = response.ok && response.body && RASTER_IMAGES.has(type) ? await boundedBytes(response.body as ByteStream, MAX_PROVIDER_THUMB_BYTES) : null;
  if (!output) {
    await response.body?.cancel().catch(() => {});
    console.error(`[storage] ${adapter.name} answered ${response.status} for a thumbnail of file ${file.id}`);
    throw thumbFailed();
  }
  return new Response(new Uint8Array(output), { headers: { ...responseHeaders(type, "inline"), "content-length": String(output.length) } });
}

const responseHeaders = (type: string, disposition: string) => ({
  "content-type": type,
  "content-disposition": disposition,
  "cache-control": "private, max-age=300",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
});

/** The caller must already have established that this file may be read. */
export async function serveFile(file: StoredFile, { thumb, range }: { thumb?: ThumbSize; range: string | null }) {
  const adapter = adapterNamed(file.storage);

  if (thumb) {
    if (!RASTER_IMAGES.has(file.type)) throw badRequest("Thumbnails are available for images only.");
    if (adapter.thumbnailUrl) {
      const focus = fileFocusOf(file);
      return providerThumbnail(file, await adapter.thumbnailUrl(file.key, { ...thumbShape(thumb), expiresIn: SIGNED_URL_SECONDS, ...(focus ? { focus } : {}) }), adapter);
    }
    const output = await thumbnail(file, thumb, adapter);
    return new Response(new Uint8Array(output), { headers: { ...responseHeaders("image/webp", "inline"), "content-length": String(output.length) } });
  }

  const disposition = contentDisposition(file.name, file.type);
  if (adapter.signedUrl) {
    const location = await adapter.signedUrl(file.key, { expiresIn: SIGNED_URL_SECONDS, contentType: file.type, disposition });
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }

  const requested = parseRange(range, file.size);
  if (requested === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}` } });

  const body = await adapter.get(file.key, requested);
  if (!body) throw notFound("File");
  const headers = { ...responseHeaders(file.type, disposition), "accept-ranges": "bytes" };
  if (!requested) return new Response(body, { headers: { ...headers, "content-length": String(file.size) } });
  return new Response(body, {
    status: 206,
    headers: { ...headers, "content-length": String(requested.end - requested.start + 1), "content-range": `bytes ${requested.start}-${requested.end}/${file.size}` },
  });
}

/**
 * Who may describe a file, or place its focal point: anyone with `file:update`, and whoever
 * uploaded it, as they can already read it. Checked here rather than in the guard, which can't
 * know who uploaded it.
 *
 * Only a file of the work's own scope value. Every value can read the instance's shared files,
 * such as a common logo, so without this a tenant's editor could rewrite what a file another
 * tenant shows says, or move its crop.
 */
export function canDescribeFile(file: StoredFile, principal: Principal) {
  if (file.scope !== fileScopeOf()) return false;
  if (principal.permissions.has("file:update")) return true;
  return principal.kind !== "anonymous" && file.createdById === principal.user.id;
}

/**
 * Sets what a file is described as, in one language. The default language's words are the
 * file's own columns, any other language's go beside them (./text.ts). Nothing here touches
 * the bytes, so no storage adapter is involved.
 */
export async function describeFile(file: StoredFile, locale: string, primary: string, values: Partial<FileText>) {
  const data = fileTextColumns(file, locale, primary, values);
  if (!Object.keys(data).length) return file;
  return prisma.storedFile.update({ where: { id: file.id }, data: data as Record<string, unknown> });
}
