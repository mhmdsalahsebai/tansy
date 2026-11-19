import { z } from "zod";
import { HttpError } from "../http/errors";
import type { SortTerm } from "./content-service";

const MAX_SORT_TERMS = 8;
const MAX_EXPAND_PATHS = 8;
const MAX_EXPAND_DEPTH = 4;
const MAX_FIELD_PATHS = 100;

const viewShape = {
  /** A language code, or "*" for every language. Ignored by collections that aren't localized. */
  locale: z.string().max(35).optional(),
  /** "none": only the language asked for, with no fallback. */
  fallback: z.enum(["none", "chain"]).optional(),
  expand: z.string().max(500).optional(),
  fields: z.string().max(2000).optional(),
  /** "1" adds one line per field whose type declares `summary`, for the record grid. */
  summaries: z.enum(["1"]).optional(),
  /** "1" adds `recordPath`, the record's address under its collection's URL pattern, or null if it has none. */
  urls: z.enum(["1"]).optional(),
  /** "1" adds each language's status, for the record grid. Only for people who may read every record of the collection through their role. */
  translations: z.enum(["1"]).optional(),
};

const listShape = {
  ...viewShape,
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(30),
  sort: z.string().max(500).optional(),
  filter: z.string().max(2048).optional(),
  /** Words to find in the collection's searchable fields. */
  search: z.string().max(500).optional(),
  /** Staff only: records whose translation in a language is missing, a draft or published, such as "de:missing". */
  translation: z.string().max(50).regex(/^[A-Za-z0-9-]{2,35}:(missing|draft|published)$/).optional(),
  skipTotal: z.enum(["true", "false", "1", "0"]).optional().transform((value) => value === "true" || value === "1"),
};

// Loose, so API rules can still read other parameters through @request.query.
export const recordViewQuery = z.object(viewShape).loose();
export const recordListQuery = z.object(listShape).loose();

export type RecordViewQuery = z.output<typeof recordViewQuery>;
export type RecordListQuery = z.output<typeof recordListQuery>;

const terms = (value: string | undefined) => (value ?? "").split(",").map((term) => term.trim()).filter(Boolean);

/** "-createdAt,title". Only the given columns can be named, so nothing else reaches the ORDER BY. */
export function parseSort(value: string | undefined, columns: ReadonlyMap<string, unknown>): SortTerm[] {
  const list = terms(value);
  if (list.length > MAX_SORT_TERMS) throw new HttpError(400, "INVALID_SORT", `Sort by at most ${MAX_SORT_TERMS} fields.`);
  return list.map((term) => {
    const column = term.replace(/^[-+]/, "");
    if (!columns.has(column)) throw new HttpError(400, "INVALID_SORT", `Cannot sort by "${column}".`);
    return { column, direction: term.startsWith("-") ? "desc" : "asc" };
  });
}

export type Tree = Map<string, Tree>;

function addPath(tree: Tree, path: string[]) {
  let level = tree;
  for (const part of path) {
    let next = level.get(part);
    if (!next) level.set(part, (next = new Map()));
    level = next;
  }
}

/** "author,author.company,comments_via_post" as a tree of relation names. */
export function parseExpand(value: string | undefined): Tree {
  const list = terms(value);
  if (list.length > MAX_EXPAND_PATHS) throw new HttpError(400, "INVALID_EXPAND", `Expand at most ${MAX_EXPAND_PATHS} relations.`);
  const tree: Tree = new Map();
  for (const entry of list) {
    const path = entry.split(".");
    if (path.length > MAX_EXPAND_DEPTH) throw new HttpError(400, "INVALID_EXPAND", `Expand at most ${MAX_EXPAND_DEPTH} levels deep.`);
    if (path.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new HttpError(400, "INVALID_EXPAND", `Cannot expand "${entry}".`);
    addPath(tree, path);
  }
  return tree;
}

/** "id,title,expand.author.name", where "*" means every key at that level. Null keeps everything. */
export function parseFields(value: string | undefined): Tree | null {
  const list = terms(value);
  if (!list.length) return null;
  if (list.length > MAX_FIELD_PATHS) throw new HttpError(400, "INVALID_FIELDS", `Select at most ${MAX_FIELD_PATHS} fields.`);
  const tree: Tree = new Map();
  for (const entry of list) {
    const path = entry.split(".");
    if (path.some((part) => part !== "*" && !/^[A-Za-z0-9_-]+$/.test(part))) throw new HttpError(400, "INVALID_FIELDS", `Cannot select "${entry}".`);
    addPath(tree, path);
  }
  return tree;
}

/** Narrows a record that has already been authorized. It can only remove keys. */
export function pickFields(value: unknown, tree: Tree): unknown {
  if (Array.isArray(value)) return value.map((item) => pickFields(item, tree));
  if (value === null || typeof value !== "object") return value;
  const wildcard = tree.has("*");
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const branch = tree.get(key);
    if (branch) return [[key, branch.size ? pickFields(item, branch) : item]];
    return wildcard ? [[key, item]] : [];
  }));
}
