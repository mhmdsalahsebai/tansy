import { adminPath, apiPath } from "../../lib/paths";
import { MAX_PATH, MAX_SEGMENTS, normalizePath } from "./path";

/** No server imports: the dashboard uses this to work out a record's address too. */

const MAX_ROW_ID = 2_147_483_647;
const LITERAL = /^[a-z0-9._~-]+$/;
const PARAM = /^:([A-Za-z][A-Za-z0-9_]*)$/;
const ROW_ID = /^[1-9][0-9]{0,9}$/;

export const insideCms = (path: string) => [adminPath(), apiPath()].some((base) => path === base || path.startsWith(`${base}/`));

type Segment = { literal: string } | { param: string };

function parsePattern(pattern: string): Segment[] | null {
  if (!pattern.startsWith("/") || pattern.length > MAX_PATH) return null;
  if (pattern === "/") return [];
  const parts = pattern.slice(1).split("/");
  if (parts.length > MAX_SEGMENTS) return null;
  const segments: Segment[] = [];
  for (const part of parts) {
    const param = PARAM.exec(part);
    if (param) segments.push({ param: param[1] });
    else if (LITERAL.test(part) && part !== "." && part !== "..") segments.push({ literal: part });
    else return null;
  }
  return segments;
}

export interface PatternField {
  name: string;
  unique: boolean;
  hidden: boolean;
  /** Stored as plain text, so a path segment can be compared with it. */
  routable: boolean;
}

/**
 * Why a collection can't use this pattern. Every parameter is checked because a
 * hidden field in an address would let anyone test its value by requesting URLs,
 * and one unique parameter is required so that an address can only mean one record.
 */
export function urlPatternProblem(pattern: string, type: string, fields: PatternField[]): string | null {
  if (type === "view") return "View collections can't have addresses.";
  const segments = parsePattern(pattern);
  if (!segments) return 'Start with "/" and use lowercase words or :field parameters between slashes, such as /blog/:slug.';
  const firstParam = segments.findIndex((segment) => "param" in segment);
  const fixed = (firstParam === -1 ? segments : segments.slice(0, firstParam)).flatMap((segment) => ("literal" in segment ? [segment.literal] : []));
  if (fixed.length && insideCms(`/${fixed.join("/")}`)) return "This address belongs to the CMS itself.";

  const params = segments.flatMap((segment) => ("param" in segment ? [segment.param] : []));
  if (new Set(params).size !== params.length) return "Each parameter can appear once.";
  if (type === "singleton") return params.length ? "A singleton has one address, so it can't have parameters." : null;
  if (!params.length) return "Add a parameter, such as :slug, so each record gets its own address.";

  let identifies = false;
  for (const param of params) {
    if (param === "id") {
      identifies = true;
      continue;
    }
    const field = fields.find((candidate) => candidate.name === param);
    if (!field) return `There is no field named "${param}".`;
    if (!field.routable) return `"${param}" can't be part of an address. Use a text field.`;
    if (field.hidden) return `"${param}" is hidden, and an address would let visitors test its value.`;
    identifies ||= field.unique;
  }
  return identifies ? null : "At least one parameter must be :id or a field marked unique, so an address can't match two records.";
}

/** Patterns with the same shape would always match the same addresses, so only one collection can have each. */
export const patternShape = (pattern: string) => pattern.split("/").map((part) => (part.startsWith(":") ? ":" : part)).join("/");

/** Fixed words win over parameters, reading from the left, so /blog/archive is tried before /blog/:slug. */
export function comparePatterns(a: string, b: string) {
  const [left, right] = [patternShape(a), patternShape(b)];
  const [leftParts, rightParts] = [left.split("/"), right.split("/")];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    const [one, other] = [leftParts[index] === ":", rightParts[index] === ":"];
    if (one !== other) return one ? 1 : -1;
  }
  return left.localeCompare(right);
}

export type PathMatch = Map<string, string | number>;

/** The column values a normalized path asks for, or null if it doesn't fit the pattern. */
export function matchPattern(pattern: string, path: string): PathMatch | null {
  const segments = parsePattern(pattern);
  if (!segments) return null;
  const parts = path === "/" ? [] : path.slice(1).split("/");
  if (segments.length !== parts.length) return null;
  const match: PathMatch = new Map();
  for (const [index, segment] of segments.entries()) {
    if ("literal" in segment) {
      if (segment.literal !== parts[index]) return null;
    } else if (segment.param === "id") {
      // Past this the column would overflow on Postgres, and no record can have it.
      if (!ROW_ID.test(parts[index]) || Number(parts[index]) > MAX_ROW_ID) return null;
      match.set("id", Number(parts[index]));
    } else {
      match.set(segment.param, decodeURIComponent(parts[index]));
    }
  }
  return match;
}

/** A record's address, or null when a value it needs is empty or can't appear in a path. */
export function buildRecordPath(pattern: string, record: Record<string, unknown>): string | null {
  const segments = parsePattern(pattern);
  if (!segments) return null;
  const parts: string[] = [];
  for (const segment of segments) {
    if ("literal" in segment) {
      parts.push(segment.literal);
      continue;
    }
    const value = record[segment.param];
    if ((typeof value !== "string" && typeof value !== "number") || value === "") return null;
    parts.push(encodeURIComponent(String(value)));
  }
  return normalizePath(`/${parts.join("/")}`);
}
