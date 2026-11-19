import { ApiError } from "../../lib/client/api";
import type { Block } from "../../core/blocks/limits";
import type { EditorInput } from "../../core/fields/define";

export interface FieldTypeInfo {
  type: string;
  label: string;
  description?: string;
  /** The plugin that registered it, for its name in the interface language. */
  plugin?: string;
  input: Exclude<EditorInput, "unavailable">;
  /** The only filter operators the type takes, when it limits them. An empty list: it can't be filtered on. */
  operators?: string[];
  configSchema: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  widget?: string;
}

/** A field being edited. `id` is set once it exists in the database. */
export interface DraftField {
  key: string;
  id?: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  /** User fields only. */
  selfEditable?: boolean;
}

export type IssueMap = Record<string, string>;

export interface FileInfo {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  /** What the file is described as, in the language asked for (core/files/text.ts). */
  alt: string;
  caption: string;
  credit: string;
  /** Where the subject of the picture is, as percentages, or null for the middle (core/files/focus.ts). */
  focus: { x: number; y: number } | null;
}

export interface FileListItem extends FileInfo {
  usedBy: number;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export interface BlockTypeInfo {
  id: number;
  name: string;
  label: string;
  /** The label in other interface languages. */
  labels?: Record<string, string> | null;
  icon?: string | null;
  version: number;
  fields: Array<{ name: string; type: string; config?: unknown }>;
  /** The plugin that defines this block, which then can't be changed here. */
  managedBy?: string | null;
  /** Set by a plugin's block definition. */
  category?: string;
  previewImage?: string;
  defaults?: Record<string, unknown>;
}

export interface FieldPresetInfo {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface BlockLayoutInfo {
  id: number;
  name: string;
  blocks: Block[];
}

/** What a stream editor needs at every level. */
export interface EditorCatalog {
  fieldTypes: FieldTypeInfo[];
  blockTypes: BlockTypeInfo[];
  blockLayouts?: BlockLayoutInfo[];
  canSaveLayouts?: boolean;
}

/** The issue at a path, or the first one below it. */
export const issueFor = (issues: IssueMap, path: string): string | undefined =>
  issues[path] ?? Object.entries(issues).find(([key]) => key.startsWith(`${path}.`))?.[1];

export const toRequest = (fields: DraftField[]) => fields.map(({ id, name, type, config }) => ({ id, name, type, config }));

/** Field-level API errors by path, such as fields.0.name. */
export const issuesOf = (error: unknown): IssueMap =>
  error instanceof ApiError && Array.isArray(error.details) ? Object.fromEntries(error.details.map((d) => [d.path, d.message])) : {};
