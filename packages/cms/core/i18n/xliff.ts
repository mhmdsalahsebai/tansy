/**
 * XLIFF 2.0, the exchange format translation tools and agencies use. One <file> per record,
 * one <unit> per segment. Export writes the source and any existing translation, and import
 * reads the targets back. No server imports.
 */
import type { Segment } from "./segments";

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);

/** Characters XML 1.0 can't hold at all. Stored text can't contain them either, so this only guards against hand-made files. */
const INVALID_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;

export interface XliffRecord {
  collection: string;
  id: number;
  /** A hash of the source text when exported, so an import can tell when the source changed since. */
  sourceHash: string;
  segments: Array<Segment & { target?: string }>;
}

export function writeXliff(records: XliffRecord[], from: string, to: string) {
  const files = records.map((record) => {
    const units = record.segments.map((segment) => [
      `      <unit id="${escape(segment.id)}">`,
      "        <segment>",
      `          <source>${escape(segment.text)}</source>`,
      ...(segment.target !== undefined ? [`          <target>${escape(segment.target)}</target>`] : []),
      "        </segment>",
      "      </unit>",
    ].join("\n"));
    return [
      `    <file id="${escape(`${record.collection}/${record.id}`)}">`,
      `      <notes><note category="cms" id="source-hash">${escape(record.sourceHash)}</note></notes>`,
      ...units,
      "    </file>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${escape(from)}" trgLang="${escape(to)}">`,
    ...files,
    "</xliff>",
    "",
  ].join("\n");
}

const UNESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescape(text: string) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return UNESCAPES[entity];
  }).replace(INVALID_XML, "");
}

/** Inline markup a tool may have added (<ph/>, <pc>) carries nothing this format stores, so only its text is kept. */
const inner = (xml: string) => unescape(xml.replace(/<[^>]{0,500}>/g, ""));

export interface ParsedXliff {
  from: string;
  to: string;
  records: Array<{ collection: string; id: number; sourceHash: string | null; targets: Map<string, string> }>;
}

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Reads the subset of XLIFF 2.0 that writeXliff produces and translation tools keep:
 * files, units, segments and targets. It's a small, strict reader rather than a full XML
 * parser: no DTDs or entities beyond the five standard ones, so nothing can expand.
 */
export function readXliff(xml: string): ParsedXliff {
  if (xml.length > MAX_BYTES) throw new Error("The file is too large.");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("The file can't declare a DTD or entities.");
  const root = /<xliff\b([^>]*)>/.exec(xml);
  if (!root || !/version="2\.\d"/.test(root[1])) throw new Error("This isn't an XLIFF 2 file.");
  const attribute = (source: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1];
  const from = unescape(attribute(root[1], "srcLang") ?? "");
  const to = unescape(attribute(root[1], "trgLang") ?? "");
  const records: ParsedXliff["records"] = [];
  for (const file of xml.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const id = unescape(attribute(file[1], "id") ?? "");
    const match = /^([a-z0-9-]{1,63})\/([1-9]\d{0,9})$/.exec(id);
    if (!match) continue;
    const hash = /<note\b[^>]*id="source-hash"[^>]*>([\s\S]*?)<\/note>/.exec(file[2]);
    const targets = new Map<string, string>();
    for (const unit of file[2].matchAll(/<unit\b([^>]*)>([\s\S]*?)<\/unit>/g)) {
      const unitId = unescape(attribute(unit[1], "id") ?? "");
      // Several segments in one unit mean a tool split it, so their targets join back up.
      const parts = [...unit[2].matchAll(/<target\b[^>]*>([\s\S]*?)<\/target>/g)].map((target) => inner(target[1]));
      if (unitId && parts.length) targets.set(unitId, parts.join(""));
    }
    records.push({ collection: match[1], id: Number(match[2]), sourceHash: hash ? inner(hash[1]) : null, targets });
  }
  return { from, to, records };
}
