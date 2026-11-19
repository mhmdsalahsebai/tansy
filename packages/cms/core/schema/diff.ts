import type { FieldStorage } from "../fields/define";
import { isKnownFieldType, resolveFieldConfig, type Issue } from "../fields/registry";
import { columnConversion, type Conversion } from "./ddl";
import { fieldNameProblem } from "./names";
import { isDeepStrictEqual } from "node:util";

export interface StoredField {
  id: number;
  name: string;
  type: string;
  config: unknown;
}

export interface RequestedField {
  id?: number;
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface ResolvedField {
  name: string;
  type: string;
  config: Record<string, unknown>;
  storage: FieldStorage;
  unique: boolean;
  /** Marked localized. Only takes effect in a collection with localization on. */
  localized: boolean;
}

export type FieldChange =
  | { kind: "remove"; field: StoredField }
  | { kind: "update"; index: number; field: StoredField; wasUnique: boolean; wasLocalized: boolean; next: ResolvedField; conversion: Conversion | null }
  | { kind: "add"; index: number; next: ResolvedField };

export interface SchemaDiff {
  changes: FieldChange[];
  /** Why the request is invalid. */
  issues: Issue[];
  /** What would lose data, which the caller must confirm. */
  destructive: Issue[];
}

type Retype = { conversion: Conversion | null } | { problem: string };

function retype(from: ResolvedField, to: ResolvedField): Retype {
  const sameColumn = from.storage.sql === to.storage.sql;
  if (from.type === to.type && from.storage.references === to.storage.references && sameColumn) return { conversion: null };
  if (from.storage.references !== to.storage.references || (from.storage.references && !sameColumn)) return { problem: "References cannot change type, target or between one and many. Add a new field instead." };
  // record_refs indexes a stream field's blocks, and nothing would keep it right after a conversion.
  if (from.type === "stream" && to.type !== "stream") return { problem: "Stream fields cannot change type. Add a new field instead." };
  // The file index would keep granting access through values that are no longer file ids.
  if (Boolean(from.storage.files) !== Boolean(to.storage.files) || (from.storage.files && !sameColumn)) return { problem: "File fields can only change between image and file. Add a new field instead." };
  // JSON-stored types hold different shapes, so only the free-form JSON type can take any of them.
  if (to.storage.sql === "json" && to.type !== "json") return { problem: `Cannot convert ${from.type} to ${to.type}. Add a new field instead.` };
  if (from.storage.sql === to.storage.sql) return { conversion: null };
  const conversion = columnConversion(from.storage.sql, to.storage.sql, from.name);
  return conversion ? { conversion } : { problem: `Cannot convert ${from.type} to ${to.type}. Add a new field instead.` };
}

/** Compares the stored fields with the requested list. Changes are ordered so that names free up before they are reused. */
/** A stream whose blocks follow the default language's. See core/i18n/synced.ts. */
export const isSynced = (field: Pick<ResolvedField, "type" | "config">) => field.type === "stream" && (field.config as { synced?: unknown } | null)?.synced === true;

export function diffFields(stored: StoredField[], requested: RequestedField[], localizedCollection = false): SchemaDiff {
  const issues: Issue[] = [];
  const destructive: Issue[] = [];
  const byId = new Map(stored.map((field) => [field.id, field]));
  const seenIds = new Set<number>();
  const seenNames = new Set<string>();
  const updates: FieldChange[] = [];
  const adds: FieldChange[] = [];

  requested.forEach((field, index) => {
    const at = `fields.${index}`;
    // A name that was valid when made stays valid, so reserving a new word ("locale") never locks an old field.
    const unchanged = field.id !== undefined && byId.get(field.id)?.name === field.name;
    const nameProblem = unchanged ? null : fieldNameProblem(field.name);
    if (nameProblem) issues.push({ path: `${at}.name`, message: nameProblem });
    const lower = field.name.toLowerCase();
    if (seenNames.has(lower)) issues.push({ path: `${at}.name`, message: "Another field already uses this name." });
    seenNames.add(lower);

    // Its plugin is gone, so its config can't be checked and its column can't be converted. It can stay as it is, or be removed.
    const orphan = field.id === undefined ? undefined : byId.get(field.id);
    if (orphan && !isKnownFieldType(orphan.type) && !seenIds.has(orphan.id)) {
      seenIds.add(orphan.id);
      if (field.type !== orphan.type || field.name !== orphan.name) issues.push({ path: `${at}.type`, message: "The plugin that provides this field is not installed, so it can only be kept or removed." });
      return;
    }

    const resolved = resolveFieldConfig(field.type, field.config);
    if (!resolved.ok) {
      issues.push(...resolved.issues.map((issue) => ({ path: `${at}.${issue.path}`, message: issue.message })));
    }

    if (field.id === undefined) {
      if (resolved.ok) adds.push({ kind: "add", index, next: { name: field.name, type: field.type, config: resolved.config, storage: resolved.storage, unique: resolved.unique, localized: resolved.localized } });
      return;
    }

    const current = byId.get(field.id);
    if (!current || seenIds.has(field.id)) {
      issues.push({ path: `${at}.id`, message: "This field does not exist in the collection." });
      return;
    }
    seenIds.add(field.id);
    if (!resolved.ok) return;

    const before = resolveFieldConfig(current.type, current.config);
    if (!before.ok) throw new Error(`Stored field ${current.id} has an invalid config.`);
    const previous: ResolvedField = { name: current.name, type: current.type, config: before.config, storage: before.storage, unique: before.unique, localized: before.localized };
    const next: ResolvedField = { name: field.name, type: field.type, config: resolved.config, storage: resolved.storage, unique: resolved.unique, localized: resolved.localized };
    if (previous.name === next.name && previous.type === next.type && isDeepStrictEqual(previous.config, next.config)) return;

    const change = retype(previous, next);
    if ("problem" in change) {
      issues.push({ path: `${at}.type`, message: change.problem });
      return;
    }
    if (change.conversion?.lossy) destructive.push({ path: `${at}.type`, message: `Converting ${previous.name} from ${previous.type} to ${next.type} clears values that cannot convert.` });
    if (localizedCollection && previous.localized && next.localized && isSynced(next) && !isSynced(previous)) destructive.push({ path: `${at}.config.synced`, message: `Syncing ${next.name}'s blocks lines every translation up with the default language's: blocks only a translation has, and its own images, links and other values that aren't text, are removed.` });
    if (localizedCollection && previous.localized && !next.localized) destructive.push({ path: `${at}.config.localized`, message: `Sharing ${previous.name} across languages keeps the default language's values and deletes the others.` });
    updates.push({ kind: "update", index, field: current, wasUnique: previous.unique, wasLocalized: previous.localized, next, conversion: change.conversion });
  });

  const removes: FieldChange[] = stored.filter((field) => !seenIds.has(field.id)).map((field) => ({ kind: "remove", field }));
  for (const change of removes) {
    if (change.kind === "remove") destructive.push({ path: change.field.name, message: `Removing ${change.field.name} deletes its values.` });
  }

  // A rename onto a name another surviving field still holds would need a temporary name.
  const kept = new Map(stored.filter((field) => seenIds.has(field.id)).map((field) => [field.name.toLowerCase(), field.id]));
  for (const change of [...updates, ...adds]) {
    if (change.kind === "remove") continue;
    const holder = kept.get(change.next.name.toLowerCase());
    const self = change.kind === "update" ? change.field.id : undefined;
    if (holder !== undefined && holder !== self) issues.push({ path: `fields.${change.index}.name`, message: "Another field still holds this name. Rename in two steps." });
  }

  return { changes: [...removes, ...updates, ...adds], issues, destructive };
}
