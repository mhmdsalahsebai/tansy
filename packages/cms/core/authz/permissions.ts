import { defaultStatements } from "better-auth/plugins/admin/access";
import { getCmsConfig } from "../config";

/**
 * The single catalogue of what can be authorized. `user` and `session` are
 * better-auth's own admin statements, so its plugin and this layer agree.
 *
 * New capabilities are added here (or by an extension in tansy.config.ts) and
 * then appear automatically in the dashboard's role editor.
 */
export const builtInStatements = {
  ...defaultStatements,
  dashboard: ["access"],
  role: ["list", "create", "update", "delete"],
  /** `site` changes the current scope value's own site name, logo and colour, such as one tenant's (core/site/identity.ts). */
  setting: ["read", "update", "site"],
  audit: ["read"],
  collection: ["read", "create", "update", "delete", "manage-rules", "manage-views"],
  /** `publish` takes changes live in a collection that requires review. Without it, people submit them for review. */
  record: ["list", "read", "create", "update", "delete", "publish"],
  /** `update` describes any file: what it shows, its caption and credit. Its uploader may describe their own. */
  file: ["list", "read", "create", "update", "delete"],
  "api-key": ["create", "list", "revoke"],
  webhook: ["read", "manage"],
  redirect: ["read", "manage"],
  /** Writing content in a language. `locale:edit@<code>` limits it to one. */
  locale: ["edit"],
} as const;

type Statements = typeof builtInStatements;
export type BuiltInPermission = {
  [R in keyof Statements]: `${R & string}:${Statements[R][number]}`;
}[keyof Statements];

/** Extension resources are namespaced so they can never shadow a built-in. */
export type ExtensionPermission = `ext.${string}:${string}`;

export type RecordVerb = Statements["record"][number];
export type RecordPermission = `record:${RecordVerb}`;
/**
 * A record permission for one collection, keyed by its id so renaming the
 * collection keeps the grant. The plain `record:*` form means every collection.
 */
export type ScopedRecordPermission = `${RecordPermission}@c${number}`;
/**
 * A record permission for only the records in one collection that the holder created
 * (`createdById`). It never covers creating, which has no record yet, or publishing,
 * since a review that authors could pass on their own records would review nothing.
 */
export type OwnRecordPermission = `record:${Exclude<RecordVerb, "create" | "publish">}@c${number}:own`;
export type LocalePermission = `locale:edit@${string}`;
export type Permission = BuiltInPermission | ExtensionPermission | ScopedRecordPermission | OwnRecordPermission | LocalePermission;

export const resourceLabels: Record<string, string> = {
  user: "Users",
  session: "User sessions",
  dashboard: "Dashboard",
  role: "Roles",
  setting: "Settings",
  audit: "Audit log",
  collection: "Collections",
  record: "Records",
  file: "Files",
  "api-key": "API keys",
  webhook: "Webhooks",
  redirect: "Redirects",
  locale: "Languages",
};

export function allStatements(): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...builtInStatements };
  for (const ext of getCmsConfig().plugins ?? []) {
    for (const [resource, actions] of Object.entries(ext.permissions ?? {})) {
      if (!resource.startsWith("ext.")) {
        throw new Error(`Extension ${ext.name}: resource "${resource}" must start with "ext."`);
      }
      merged[resource] = actions;
    }
  }
  return merged;
}

/**
 * Plugin permissions a scoped role may hold (`scopedPermissions` in a plugin's manifest): ones
 * that mean something inside one scope value, such as managing a tenant's members. Each must be
 * the plugin's own, and never an `all` action, which by its name reaches past one value.
 */
export function scopeablePluginPermissions(): Set<string> {
  const out = new Set<string>();
  for (const ext of getCmsConfig().plugins ?? []) {
    for (const permission of ext.scopedPermissions ?? []) {
      const [resource, action] = permission.split(":");
      if (!resource || !action || !(ext.permissions?.[resource] ?? []).includes(action)) {
        throw new Error(`Extension ${ext.name}: scoped permission "${permission}" isn't one of its own permissions.`);
      }
      if (action === "all") throw new Error(`Extension ${ext.name}: "${permission}" reaches every scope value, so a scoped role can't hold it.`);
      out.add(permission);
    }
  }
  return out;
}

export function allPermissions(): Permission[] {
  return Object.entries(allStatements()).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}` as Permission),
  );
}

/** One language, for `locale:edit`. Whoever stores one checks that the language exists. */
const LOCALE_SCOPED = /^locale:edit@[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;
const SCOPED = /^record:(list|read|create|update|delete|publish)@c([1-9]\d{0,15})$/;
const OWN = /^record:(list|read|update|delete)@c([1-9]\d{0,15}):own$/;

export const scopedRecordPermission = (permission: RecordPermission, collectionId: number): ScopedRecordPermission =>
  `${permission}@c${collectionId}`;

export const ownRecordPermission = (permission: RecordPermission, collectionId: number) => `${permission}@c${collectionId}:own`;

/** The collection a scoped or own grant names, or null for anything else. */
export function scopedCollectionId(value: string): number | null {
  const match = SCOPED.exec(value) ?? OWN.exec(value);
  return match ? Number(match[2]) : null;
}

/** Whether this is an own grant, which covers only records the holder created. */
export const isOwnRecordPermission = (value: string) => OWN.test(value);

/** Holds this record permission for every collection, or for this one. */
export function holdsRecordPermission(permissions: ReadonlySet<string>, permission: RecordPermission, collectionId: number): boolean {
  return permissions.has(permission) || permissions.has(scopedRecordPermission(permission, collectionId));
}

/** Holds this record permission for only the records in this collection that the holder created. */
export function holdsOwnRecordPermission(permissions: ReadonlySet<string>, permission: RecordPermission, collectionId: number): boolean {
  return permissions.has(ownRecordPermission(permission, collectionId));
}

/**
 * Holds this record permission for this collection, for all its records or only for their own.
 * Only for gates whose handler then checks the record itself, through authorizeRecord.
 */
export function holdsRecordPermissionForSome(permissions: ReadonlySet<string>, permission: RecordPermission, collectionId: number): boolean {
  return holdsRecordPermission(permissions, permission, collectionId) || holdsOwnRecordPermission(permissions, permission, collectionId);
}

/** Whether `held` covers `permission`. A global record permission covers each collection's, and a collection's covers its own grant. */
export function grants(held: ReadonlySet<string>, permission: string): boolean {
  if (held.has(permission)) return true;
  if (LOCALE_SCOPED.test(permission)) return held.has("locale:edit");
  const match = SCOPED.exec(permission) ?? OWN.exec(permission);
  if (!match) return false;
  return held.has(`record:${match[1]}`) || held.has(`record:${match[1]}@c${match[2]}`);
}

/** Holds this record permission for at least one collection, own grants included. Only for deciding what to offer, never to authorize. */
export function holdsRecordPermissionAnywhere(permissions: Iterable<string>, permission: RecordPermission): boolean {
  for (const held of permissions) if (held === permission || held.startsWith(`${permission}@c`)) return true;
  return false;
}

/** Scoped and own grants are checked here by form only. Whoever stores one checks that the collection exists. */
export function isKnownPermission(value: string): value is Permission {
  return SCOPED.test(value) || OWN.test(value) || LOCALE_SCOPED.test(value) || allPermissions().includes(value as Permission);
}

/** Convert ["user:list", "user:ban"] to better-auth's { user: ["list", "ban"] }. */
export function toStatements(permissions: Iterable<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const permission of permissions) {
    const index = permission.lastIndexOf(":");
    const resource = permission.slice(0, index);
    (out[resource] ??= []).push(permission.slice(index + 1));
  }
  return out;
}

export function fromStatements(statements: Record<string, string[]> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const [resource, actions] of Object.entries(statements ?? {})) {
    for (const action of actions) out.add(`${resource}:${action}`);
  }
  return out;
}
