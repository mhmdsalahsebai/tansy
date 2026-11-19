/** How many leading bytes detectType needs. */
export const SNIFF_BYTES = 4100;

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((byte, index) => bytes[index] === byte);

function isoMediaType(brand: string) {
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "image/heic";
  if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
  if (brand === "qt  ") return "video/quicktime";
  return "video/mp4";
}

/** Markup is worth recognising because browsers would run it. Leading comments and prologs can't hide it. */
function markupType(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    .replace(/^﻿/, "")
    .replace(/^(\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)+/, "")
    .toLowerCase();
  if (/^<!doctype svg\b/.test(text) || /^<svg[\s>/]/.test(text)) return "image/svg+xml";
  if (/^<!doctype html\b/.test(text) || /^<(html|head|body|script|iframe|title|meta|link|style)[\s>/]/.test(text)) return "text/html";
  return null;
}

const looksLikeText = (bytes: Uint8Array) => !bytes.includes(0);

/** Formats that are ZIP files inside, which their bytes alone can't tell apart. */
const ZIP_BASED = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/epub+zip",
]);

/** Text formats a client may name, since their bytes look like any other text. None of these run in a browser. */
const TEXT_BASED = new Set(["text/csv", "text/markdown", "application/json", "text/plain"]);

/**
 * The type a file really is, from its leading bytes. The type a client declares
 * is used only to choose among formats whose bytes look the same.
 */
export function detectType(bytes: Uint8Array, declared?: string | null): string {
  const claimed = declared?.split(";")[0].trim().toLowerCase() ?? "";

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const head = ascii(bytes, 0, 4);
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (head === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (head === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(bytes, 4, 8) === "ftyp") return isoMediaType(ascii(bytes, 8, 12));
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (head === "%PDF") return "application/pdf";
  if (head === "OggS") return "audio/ogg";
  if (head === "fLaC") return "audio/flac";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && bytes.length > 1 && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return ZIP_BASED.has(claimed) ? claimed : "application/zip";

  const markup = markupType(bytes);
  if (markup) return markup;
  if (looksLikeText(bytes)) return TEXT_BASED.has(claimed) ? claimed : "text/plain";
  return "application/octet-stream";
}

/** Types browsers render without running anything. SVG is left out because it can hold scripts. */
export const RASTER_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const INLINE_MEDIA = new Set(["video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "audio/flac"]);

export const servesInline = (type: string) => RASTER_IMAGES.has(type) || INLINE_MEDIA.has(type);

/** Whether a type is on a field's allowedTypes. `image/*` covers raster images only, so SVG must be named. */
export function typeAllowed(type: string, allowed: string[] | undefined) {
  if (!allowed?.length) return true;
  return allowed.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "*/*" || pattern === type) return true;
    if (!pattern.endsWith("/*")) return false;
    if (pattern === "image/*") return RASTER_IMAGES.has(type);
    return type.startsWith(pattern.slice(0, -1));
  });
}
