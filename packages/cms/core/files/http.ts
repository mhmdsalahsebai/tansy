import type { ByteRange } from "../storage/types";
import { servesInline } from "./sniff";

/** Keeps only the last path segment, without control characters. */
export function safeFileName(raw: string) {
  const name = raw.split(/[/\\]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.slice(-255) || "file";
}

/** Anything a browser might run downloads instead of rendering. */
export function contentDisposition(name: string, type: string) {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${servesInline(type) ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** A single byte range. Anything malformed or multi-part means the whole file, which HTTP allows. */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size) return "unsatisfiable";
  return start > end ? undefined : { start, end };
}
