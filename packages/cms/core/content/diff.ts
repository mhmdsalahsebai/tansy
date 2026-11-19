import { isDeepStrictEqual } from "node:util";
import { valueSummary } from "../fields/registry";

interface BlockLike {
  id: string;
  type: string;
  value: Record<string, unknown>;
}

export interface BlockChange {
  id: string;
  type: string;
  change: "added" | "removed" | "changed" | "moved";
  /** For a changed block: what differs in each of its fields, with nested streams compared block by block. */
  fields?: Array<{ name: string; before: unknown; after: unknown; blocks?: BlockChange[] }>;
}

export interface FieldChange {
  fieldId: number;
  name: string;
  type: string;
  before: unknown;
  after: unknown;
  /** Set for types that declare `summary`. */
  beforeSummary?: string;
  afterSummary?: string;
  /** Set when both sides are block lists. */
  blocks?: BlockChange[];
}

function isBlockList(value: unknown): value is BlockLike[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.type === "string" && item.value && typeof item.value === "object");
}

/** The ids that kept their relative order, as a longest common subsequence, so moving one block reports one block. */
function stableIds(before: string[], after: string[]) {
  const lengths = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const stable = new Set<string>();
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i] === after[j]) { stable.add(before[i]); i++; j++; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  return stable;
}

/** Blocks are matched by their stable id, so edits and reorders are told apart. */
export function diffBlocks(before: BlockLike[], after: BlockLike[]): BlockChange[] {
  const previous = new Map(before.map((block) => [block.id, block]));
  const current = new Map(after.map((block) => [block.id, block]));
  const stable = stableIds(before.map((b) => b.id).filter((id) => current.has(id)), after.map((b) => b.id).filter((id) => previous.has(id)));

  const changes: BlockChange[] = [];
  for (const block of after) {
    const old = previous.get(block.id);
    if (!old) {
      changes.push({ id: block.id, type: block.type, change: "added" });
      continue;
    }
    const names = [...new Set([...Object.keys(old.value), ...Object.keys(block.value)])];
    const fields = names.filter((name) => !isDeepStrictEqual(old.value[name], block.value[name])).map((name) => {
      const [was, now] = [old.value[name], block.value[name]];
      return { name, before: was ?? null, after: now ?? null, ...(isBlockList(was) && isBlockList(now) ? { blocks: diffBlocks(was, now) } : {}) };
    });
    if (fields.length) changes.push({ id: block.id, type: block.type, change: "changed", fields });
    else if (!stable.has(block.id)) changes.push({ id: block.id, type: block.type, change: "moved" });
  }
  for (const block of before) if (!current.has(block.id)) changes.push({ id: block.id, type: block.type, change: "removed" });
  return changes;
}

type StoredValues = Record<string, unknown>;

/** Only fields that still exist are compared. A side with no snapshot counts as empty. */
export function diffValues(fields: Array<{ id: number; name: string; type: string; config?: unknown }>, before: StoredValues | null, after: StoredValues): FieldChange[] {
  return fields.flatMap((field) => {
    const [was, now] = [before?.[field.id] ?? null, after[field.id] ?? null];
    if (isDeepStrictEqual(was, now)) return [];
    const blocks = field.type === "stream" && isBlockList(was ?? []) && isBlockList(now ?? []) ? diffBlocks((was ?? []) as BlockLike[], (now ?? []) as BlockLike[]) : undefined;
    const [beforeSummary, afterSummary] = [valueSummary(field, was), valueSummary(field, now)];
    return [{ fieldId: field.id, name: field.name, type: field.type, before: was, after: now, ...(blocks ? { blocks } : {}), ...(beforeSummary !== undefined ? { beforeSummary } : {}), ...(afterSummary !== undefined ? { afterSummary } : {}) }];
  });
}
