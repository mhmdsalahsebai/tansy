import type { ModelCapabilities, Modality } from "./provider";

/**
 * What the chat lets people attach, shared by the composer and the server. Text files go to
 * any model as text; pictures, PDFs, sound and video only to a model that reads them.
 */

/** The largest file a person may attach: 8 MB. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The largest picture a model may draw and the chat keep. */
export const MAX_DRAWN_BYTES = 12 * 1024 * 1024;

/** The most files on one message. */
export const MAX_ATTACHMENTS = 5;

/** What may be attached, and how a model reads each. Never SVG or HTML: a browser would run them. */
export const ATTACHMENT_TYPES: Record<string, Modality | "text"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "file",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
  "video/mp4": "video",
  "video/webm": "video",
};

/** What the browser calls a file, as one of the types above, or null when it can't be attached. */
export function attachmentType(type: string, name = ""): string | null {
  const base = type.split(";")[0].trim().toLowerCase();
  if (base === "audio/mp3") return "audio/mpeg";
  if (base === "audio/x-wav" || base === "audio/wave") return "audio/wav";
  if (base in ATTACHMENT_TYPES) return base;
  // Browsers often give Markdown and CSV no type, or a vendor one.
  if (/\.(md|markdown)$/i.test(name)) return "text/markdown";
  if (/\.csv$/i.test(name)) return "text/csv";
  if (/\.(txt|log)$/i.test(name)) return "text/plain";
  return null;
}

/**
 * The kinds of file a model reads, as its provider reports them. A model whose provider
 * doesn't say is taken at its name: one that sees pictures usually reads PDFs too.
 */
export function readableKinds(capabilities: ModelCapabilities | undefined): Set<Modality | "text"> {
  const input = capabilities?.input ?? [];
  const kinds = new Set<Modality | "text">(["text", ...input]);
  if (!capabilities?.reported && input.includes("image")) kinds.add("file");
  return kinds;
}

/** The types a model may be sent, for the file picker's `accept`. */
export function acceptedTypes(capabilities: ModelCapabilities | undefined): string[] {
  const kinds = readableKinds(capabilities);
  return Object.entries(ATTACHMENT_TYPES).filter(([, kind]) => kinds.has(kind)).map(([type]) => type);
}

/** Whether a model takes anything beyond text files. */
export const readsMedia = (capabilities: ModelCapabilities | undefined) => [...readableKinds(capabilities)].some((kind) => kind !== "text");
