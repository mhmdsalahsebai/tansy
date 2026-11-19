import type { Translator } from "../i18n/segments";
import type { Messages } from "../i18n/messages";
import type { z } from "zod";
import type { AuthExtension } from "../auth/extensions";
import type { ExtensionCaptcha } from "../captcha/types";
import type { Permission } from "../authz/permissions";
import type { ScopeProvider } from "../scope/provider";
import type { ScopeUsage } from "../scope/data";
import type { Principal } from "../authz/principal";
import type { FieldDefinition } from "../fields/define";
import type { CspAdditions } from "./csp";
import type { EveryPageInfo } from "../site/page";

export type RecordValues = Record<string, unknown>;

/**
 * Reads and writes that pass the same rules and validation as the HTTP API.
 * Reads take `locale` (and `fallback: "none"`) in the query, as the HTTP API does. Writes
 * take `locale` in their options: the language a localized collection's values go to,
 * the default otherwise. Collections that aren't localized ignore both.
 */
export interface RecordsApi {
  list(collection: string, query?: Record<string, unknown>): Promise<{ page: number; perPage: number; totalItems: number; totalPages: number; items: RecordValues[] }>;
  get(collection: string, id: number, query?: Record<string, unknown>): Promise<RecordValues>;
  /**
   * `owner` makes a user the record's creator, so their own-record permissions cover it.
   * Only `system.records` takes it. On `records` it is refused.
   */
  create(collection: string, data: RecordValues, options?: { owner?: string; locale?: string }): Promise<RecordValues>;
  update(collection: string, id: number, data: RecordValues, options?: { locale?: string }): Promise<RecordValues>;
  /**
   * Writes only while the stored record still has these values, checked in the UPDATE
   * itself, so of two writers racing from the same state exactly one matches. Returns null,
   * writing nothing, when it doesn't match. Takes fields of plain values (text, number,
   * boolean, select) the caller can read, and `status`. Before-hooks run only when the
   * record matched when read.
   */
  update(collection: string, id: number, data: RecordValues, options: { if: Record<string, string | number | boolean | null>; locale?: string }): Promise<RecordValues | null>;
  delete(collection: string, id: number): Promise<void>;
}

/** Values only this plugin reads. For data people edit, declare a collection instead. */
export interface PluginStore {
  /** The stored value, or null. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /**
   * Stores the value only if the key is absent, atomically. True when this call stored it.
   * Of any number of concurrent claims of one key, exactly one gets true, such as for
   * handling a provider's webhook event once.
   */
  claim(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * Keys starting with `prefix`, in key order. `before` keeps only keys sorting below it, `order`
   * "desc" lists from the highest key down, and `limit` stops after that many, so time-ordered
   * keys can be read newest first, one page at a time.
   */
  list(prefix?: string, options?: StoreListOptions): Promise<Array<{ key: string; value: unknown }>>;
  /** Deletes every key starting with `prefix`, and with `before` only those sorting below it, without reading them. Returns how many. */
  deleteMany(prefix: string, options?: { before?: string }): Promise<number>;
}

export interface StoreListOptions {
  before?: string;
  order?: "asc" | "desc";
  limit?: number;
}

/**
 * One API request, after its response. Only the path is given: the query string can carry
 * tokens. Nothing from the body or the headers but the user agent.
 */
export interface ApiRequest {
  at: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** The signed-in user or API key's user, null for a visitor. */
  actorId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Plain text, with blank lines between paragraphs, or rich text. Links go in `action`, which must be http or https. */
export interface ExtensionEmail {
  to: string;
  /** Where replies go, such as the visitor who filled in a form. One address. */
  replyTo?: string;
  /** One line, up to 200 characters. The site's name is added after it. */
  subject: string;
  /** Plain text. Leave it out when giving `richText`. */
  body?: string;
  /**
   * Formatted text, as a rich text field stores it: headings, lists, quotes, links and the
   * rest. Core turns it into email HTML and plain text, and drops anything else.
   */
  richText?: unknown;
  action?: { label: string; url: string };
  /** The language the text is in, such as "ar", so the email reads right to left where it should. Text is never translated for you. */
  locale?: string;
  /**
   * For mail sent to many people, such as a newsletter: where this recipient stops getting it.
   * Core adds the link under the message and the List-Unsubscribe headers mail clients show
   * a button for, and marks it as bulk mail. Both addresses must be http or https.
   */
  unsubscribe?: { url: string; oneClick?: string; label?: string };
}

/** What became of one message of `sendBatch`. The reason never quotes the mail server or provider. */
export type ExtensionMailResult = { ok: true } | { ok: false; error: string };

export interface ExtensionMail {
  /** Queues the email through the site's mail settings. Throws only when the message is invalid. Delivery failures are logged. */
  send(email: ExtensionEmail): Promise<void>;
  /**
   * Sends up to 100 emails now and waits, reporting each one in order, for a sender that has
   * to know what went, such as a newsletter's campaign. Uses the email plugin's batch API when
   * it has one. Throws only when a message is invalid, and then sends none. Audited once per
   * batch, with counts and no addresses.
   */
  sendBatch(emails: ExtensionEmail[]): Promise<ExtensionMailResult[]>;
  /** Whether the site can deliver email: an email plugin is ready or SMTP is set. Otherwise mail is only logged. */
  ready(): Promise<boolean>;
}

/** A collection's shape, as Dashboard → Schema exports it. Reference fields name their collection by slug. */
export interface CollectionShape {
  slug: string;
  name: string;
  type: "base" | "singleton" | "view";
  urlPattern: string | null;
  fields: Array<{ name: string; type: string; config: Record<string, unknown> }>;
}

export interface ExtensionSchema {
  /** Null when there's no collection with that slug. Owners can change collections at any time, so check before relying on a field. */
  describe(slug: string): Promise<CollectionShape | null>;
  /** The site's public languages, the default first, and a record's address in each. One item on a site with one language. */
  languages(): Promise<SiteLanguages>;
}

export interface SiteLanguages {
  defaultLocale: string;
  items: Array<{ code: string; label: string; direction: "ltr" | "rtl" }>;
  /** A site address in a language: "/blog/x" in French is "/fr/blog/x", or "https://fr.example.com/blog/x" with a domain per language. */
  href(path: string, locale: string): string;
}

/**
 * Custom user fields, which rules read as @request.auth.<name>. A plugin reaches only
 * fields named with its prefix, such as lms_courses for the lms plugin, and declares
 * them in a migration with schema.apply({ userFields }). Make them hidden, so the
 * user doesn't see a value that only matters to rules.
 */
/** Who a user is, for addressing them: in an email, or by name on something issued to them. */
export interface ExtensionUser {
  id: string;
  name: string;
  email: string;
  /** The language to write to them in: the one they chose under their account, otherwise the site's default. As account email uses. */
  locale: string;
}

export interface ExtensionUsers {
  /** Null when there's no such user. Read-only: an extension can't change who someone is. */
  get(userId: string): Promise<ExtensionUser | null>;
  /** The user with this email address, ignoring case, or null. */
  findByEmail(email: string): Promise<ExtensionUser | null>;
  /** This extension's fields for one user, by name, hidden ones included. Unset fields show their default. Null when there's no such user. */
  getValues(userId: string): Promise<Record<string, unknown> | null>;
  /**
   * Changes only the fields named, and null clears one. Validated like the dashboard's
   * form, audited under this extension's name, and refused for a field users can edit
   * themselves. Rules see the change on the user's next request.
   */
  setValues(userId: string, values: Record<string, unknown>): Promise<void>;
}

/** A plugin's settings, as saved under its section's Settings. */
export interface ExtensionSettings {
  /** Every setting the plugin declares: the saved value, or the field's default. Empty for a hook file. */
  get(): Promise<Record<string, unknown>>;
}

/** Row scopes, as plugins see them (SECURITY_MODEL.md, "Row scopes"). */
export interface ExtensionScope {
  /** The scope value, such as a tenant, the current work is for. Null outside one, or without a scope provider. */
  value(): string | null;
  /**
   * Wraps work to run later, such as from a timer or a batch, in the scope value it was wrapped
   * in, so its store, records and settings stay that value's. It only ever returns to a value the
   * work was already in.
   */
  bind<A extends unknown[], R>(work: (...args: A) => R): (...args: A) => R;
  /**
   * Where the current value's site begins, for absolute links in emails and feeds: the origin
   * of its own site, such as "https://acme.example", or the instance's address with the value's
   * path prefix on the end, such as "https://cms.example/acme", when it is served under one.
   * Null outside a value, or when it has neither: then use the site address the plugin was given.
   *
   * It can hold a path, so write a path after it rather than joining it with
   * `new URL(path, base)`, which drops a path on the base.
   */
  siteUrl(): Promise<string | null>;
  /**
   * One value's data as a whole (C33). `usage` is open to every plugin. The rest only to the
   * plugin that provides row scopes, which decides when: an archive of every row and file of
   * the value (a .tar.gz in a temporary folder, removed by `cleanup`), putting one into a value
   * that holds nothing yet, and removing all of a value's rows and files.
   */
  data: {
    usage(value: string): Promise<ScopeUsage>;
    export(value: string): Promise<{ path: string; name: string; cleanup(): Promise<void> }>;
    import(value: string, file: string): Promise<{ records: number; files: number }>;
    purge(value: string): Promise<{ records: number; files: number }>;
  };
  /** After a value's limits change, so they apply at once rather than within seconds. Without a value, every one's. */
  forgetLimits(value?: string): Promise<void>;
}

export interface ExtensionContext {
  /** The plugin's settings, which people with the settings permission change in the dashboard. */
  settings: ExtensionSettings;
  /** As a signed-out visitor, so API rules apply. In a route handler, as the caller. */
  records: RecordsApi;
  /** Ignores API rules and sees hidden fields. Writes are audited under this plugin's name. Never return its results to a caller unchecked. */
  system: { records: RecordsApi; users: ExtensionUsers };
  /** Namespaced to this plugin or hook file. */
  store: PluginStore;
  /** Email through the site's mail settings. */
  mail: ExtensionMail;
  /** The site's CAPTCHA, from whichever plugin supplies one. */
  captcha: ExtensionCaptcha;
  /** Reads collections' fields. Read-only. */
  schema: ExtensionSchema;
  /** The scope value the work is for, such as a tenant, and a way to keep later work in it. */
  scope: ExtensionScope;
}

export interface HookCollection { id: number; slug: string; name: string }

export interface BeforeHookContext extends ExtensionContext {
  event: BeforeEvent;
  collection: HookCollection;
  userId: string | null;
  /**
   * Whether whoever is writing holds this permission, such as "ext.blog:credit". A visitor
   * holds nothing, an API key what it was given, and a plugin's system write everything.
   * A global record permission covers a collection's, as in roles.
   */
  can(permission: Permission): boolean;
  /** The status being saved, on create and update. */
  status?: "draft" | "published";
  /** Validated values about to be written. Change them, or return a replacement. Empty on delete. */
  values: RecordValues;
  /** The stored record, on update and delete. */
  record?: RecordValues;
  /** Stops the write with a 400, optionally on one field. */
  reject(message: string, field?: string): never;
}

/**
 * After-hooks are durable: the event is saved with the write, and a hook that throws or
 * times out is retried with backoff, across restarts, until it succeeds. So a hook may run
 * more than once for one write, and must be safe to repeat.
 */
export interface AfterHookContext extends ExtensionContext {
  event: AfterEvent;
  collection: HookCollection;
  /** As stored by the write. On afterDelete, the record that was deleted. */
  record: RecordValues;
  /** On record.afterUpdate only: the record as stored before the write, with the same fields. */
  previous?: RecordValues;
}

export type BeforeEvent = "record.beforeCreate" | "record.beforeUpdate" | "record.beforeDelete";
export type AfterEvent = "record.afterCreate" | "record.afterUpdate" | "record.afterDelete";

/** Everything after a commit that isn't a record write. Never carries file contents, passwords or tokens. */
export interface LifecycleData {
  "file.afterUpload": { file: { id: string; name: string; type: string; size: number; createdById: string | null } };
  "file.afterDelete": { file: { id: string; name: string; type: string; size: number; createdById: string | null } };
  /** The same file, with new bytes under its own id, so whatever uses it now shows them (core/files/service.ts). */
  "file.afterReplace": { file: { id: string; name: string; type: string; size: number; createdById: string | null } };
  "schema.afterCreate": { collection: HookCollection };
  "schema.afterUpdate": { collection: HookCollection };
  "schema.afterDelete": { collection: Pick<HookCollection, "id" | "slug"> };
  "auth.afterSignUp": { user: { id: string; email: string } };
  "auth.afterSignIn": { user: { id: string } };
  "auth.afterSignOut": { user: { id: string | null } };
  "plugin.afterInstall": { plugin: { name: string; version: string } };
  "plugin.afterUpgrade": { plugin: { name: string; version: string }; previousVersion: string };
}

export type LifecycleEvent = keyof LifecycleData;
export type HookEvent = BeforeEvent | AfterEvent | LifecycleEvent;
export type LifecycleHookContext<E extends LifecycleEvent = LifecycleEvent> = ExtensionContext & { event: E; data: LifecycleData[E] };
export type LifecycleHook<E extends LifecycleEvent = LifecycleEvent> = (context: LifecycleHookContext<E>) => void | Promise<void>;

export type BeforeHook = (context: BeforeHookContext) => void | RecordValues | Promise<void | RecordValues>;
export type AfterHook = (context: AfterHookContext) => void | Promise<void>;
export type HookMap = { [E in BeforeEvent]?: BeforeHook } & { [E in AfterEvent]?: AfterHook } & { [E in LifecycleEvent]?: LifecycleHook<E> };

export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = ["file.afterUpload", "file.afterDelete", "file.afterReplace", "schema.afterCreate", "schema.afterUpdate", "schema.afterDelete", "auth.afterSignUp", "auth.afterSignIn", "auth.afterSignOut", "plugin.afterInstall", "plugin.afterUpgrade"];

export const HOOK_EVENTS: readonly HookEvent[] = ["record.beforeCreate", "record.afterCreate", "record.beforeUpdate", "record.afterUpdate", "record.beforeDelete", "record.afterDelete", ...LIFECYCLE_EVENTS];

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A route's way into the better-auth plugins its own plugin added in `auth.plugins`. */
export interface ExtensionAuth {
  /**
   * Calls one of those plugins' endpoints by its path, such as "/subscription/upgrade", as
   * the caller: with their session, so the endpoint sees who they are and nothing more.
   * Works for paths in `auth.serverOnlyPaths` too. Endpoints of other plugins, or of core,
   * can't be called. An error the endpoint throws becomes the route's error response.
   */
  call<T = unknown>(path: string, input?: { body?: Record<string, unknown>; query?: Record<string, unknown> }): Promise<T>;
  /**
   * Calls one of the same endpoints as the server, with no caller at all, by its path or, for
   * an endpoint better-auth exposes only on the server, its `auth.api` name, such as
   * "addMember". better-auth then trusts what the input says, such as which user to act for,
   * so only call it after the route's own checks, with values the route chose.
   */
  server<T = unknown>(endpoint: string, input?: { body?: Record<string, unknown>; query?: Record<string, unknown> }): Promise<T>;
  /** Reads every plugin's `auth.trustedOrigins` again now, on this server, after a change to what this plugin trusts. Other servers catch up within 30 seconds. */
  refreshTrustedOrigins(): Promise<void>;
}

export interface ExtensionRouteContext<B = unknown, Q = unknown> extends ExtensionContext {
  request: Request;
  principal: Principal;
  body: B;
  query: Q;
  params: Record<string, string>;
  /** The caller's address, from the client IP header set under Settings → Network. Null when unknown. */
  ip: string | null;
  auditTarget(type: string, id: string, metadata?: Record<string, unknown>): void;
  auth: ExtensionAuth;
  /** Every agent tool, core's and every plugin's, as the caller. For handing the CMS to an AI model. */
  tools: ExtensionTools;
}

/** Who may call an agent tool. Checked again on every call, whoever lists it. */
export type ToolAccess = { access: "authenticated" } | { access: "permission"; permission: Permission };

export interface AgentToolContext<I = unknown> extends ExtensionContext {
  /** Validated against the tool's `input`. Written by an AI model, so treat it like any request body. */
  input: I;
  /** Whoever the tool runs for. `records` acts as them. */
  principal: Principal;
  /** The other tools, as the same caller, such as create_record, which takes rich text as Markdown and fills in blocks' ids. */
  tools: ExtensionTools;
  /**
   * Names what this call touched, for the audit entry core writes: the type and id reach the
   * entry as its target, and the metadata joins core's own. Never put secrets, or field values a
   * model wrote, in the metadata.
   */
  auditTarget(type: string, id: string, metadata?: Record<string, unknown>): void;
}

/**
 * Something an AI agent can do in the CMS, such as creating a course with its lessons in
 * one step. Served to outside agents over MCP at /api/mcp, and to plugins through
 * `context.tools`, so an in-dashboard assistant gets it too. Runs as the caller: use
 * `records`, never `system.records`, for anything the caller asked for.
 */
export interface AgentTool<I extends z.ZodType = z.ZodType> {
  /** Starts with the plugin's prefix, such as lms_create_course. Letters, digits and underscores. */
  name: string;
  /** What it does and when to use it, for the model choosing a tool. */
  description: string;
  /** The arguments. MCP clients get it as JSON Schema, so keep to what JSON Schema can say. */
  input: I;
  access: ToolAccess;
  /** Whether it creates, changes or deletes anything. An assistant asks the person before running one. */
  write: boolean;
  /** Required for a write: the audit action each call is logged under, such as "lms.create_course". */
  audit?: string;
  /** Its result reaches the model as JSON. Never return what `system.records` read unchecked. */
  handler(context: AgentToolContext<z.output<I>>): unknown;
}

/** One tool as a caller sees it. */
export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  write: boolean;
}

export interface ExtensionTools {
  /** The tools the caller may run. */
  list(): Promise<ToolInfo[]>;
  /**
   * Runs one as the caller and returns its result. Bad input or a refusal throws the
   * same error the HTTP API would give. Each call is audited on its own, as
   * `tool.call` or the tool's write action, with `via` naming this plugin.
   */
  call(name: string, input: unknown): Promise<unknown>;
  /**
   * The same tools, limited to what this role grants as well: never more than the caller
   * holds, and still as the caller, so records keep their owner. Each call's audit entry
   * names the role. Throws when there's no such role. For an assistant that should act
   * with less than the person using it.
   */
  withRole(role: string): Promise<ExtensionTools>;
  /**
   * The site's roles, by name, to offer as choices for `withRole`. `scope` says whether a role
   * applies across the site or only within one row scope value, where a scope provider gives it.
   */
  roles(): Promise<Array<{ name: string; label: string; description?: string; scope: "instance" | "scoped" }>>;
}

type RouteAccess = { access: "public"; reason: string } | { access: "authenticated" } | { access: "permission"; permission: Permission };

/**
 * A plugin's routes are served at /api/ext/<plugin><path>, and a hook file's at
 * /api/ext<path>. `:name` segments become params. Every route states its access,
 * and a write that isn't public must name an audit action.
 */
export type ExtensionRoute<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType> = RouteAccess & {
  method: HttpMethod;
  path: string;
  body?: B;
  query?: Q;
  fresh?: boolean;
  apiKey?: boolean;
  audit?: string;
  rateLimit?: { window: number; max: number };
  /** On a plugin's route for a single file name, such as /sitemap.xml: also serve it at the site root, when no page or static file has that name. */
  root?: boolean;
  handler(context: ExtensionRouteContext<z.output<B>, z.output<Q>>): unknown;
};

/** What a plugin's `everyPage` function gets: its own context, and the page being rendered. */
export interface EveryPageContext extends ExtensionContext {
  page: EveryPageInfo;
}

/**
 * Props for one of the plugin's components on every site page. Runs on the server as the
 * page renders, so it can read the plugin's settings. Returns JSON the browser may see,
 * never a secret, or null to leave the component off this page.
 */
export type EveryPageFunction = (context: EveryPageContext) => unknown;

export interface JobDefinition {
  /** Unique across the instance. Its last run is stored under this name. */
  name: string;
  /** Five fields in UTC: minute, hour, day of month, month, day of week. */
  cron: string;
  /**
   * With a scope provider, such as multi-tenant, also runs once inside each active value after
   * the run outside any, so `store`, `records` and settings are that value's, as for one
   * tenant's queue. A shared collection's records are seen in every run. Without a provider it
   * runs once, as if not set.
   */
  perScope?: boolean;
  handler(context: ExtensionContext, run: JobRunInfo): void | Promise<void>;
}

/**
 * About the run a job handler is in. On a host that stops functions after a time, such as
 * Vercel, background work runs in passes with a deadline: a long job does part of its work,
 * stops before `deadline`, and its next run carries on. On a server that stays up there is
 * none, and `timeLeft()` is Infinity.
 */
export interface JobRunInfo {
  /** When this pass must be done, in milliseconds since the epoch, or null when there's no limit. */
  deadline: number | null;
  /** Milliseconds until the deadline. */
  timeLeft(): number;
}

export interface PluginBlock {
  name: string;
  label: string;
  /** The label in other interface languages, such as `{ ar: "صورة" }`. `label` covers any language missing. */
  labels?: Record<string, string>;
  icon?: string;
  /** Groups the block in the editor's add menu. */
  category?: string;
  /** An image shown in the add menu. Same-origin, or an origin the plugin lists under `csp.img`. */
  previewImage?: string;
  /** Starting values for a new block. The server validates them like anything else submitted. */
  defaults?: Record<string, unknown>;
  fields: Array<{ name: string; type: string; config?: Record<string, unknown> }>;
  /** Steps that bring stored blocks up to date on read, by the version they start from. */
  upgrades?: Record<number, (value: Record<string, unknown>) => Record<string, unknown>>;
}

/**
 * Record access a plugin's role asks for in one collection. `:own` covers only the records the user created.
 * `publish` takes changes live where the collection requires review.
 */
export type PluginRecordGrant = "list" | "read" | "create" | "update" | "delete" | "publish" | "list:own" | "read:own" | "update:own" | "delete:own";

export interface PluginRole {
  /** Starts with the plugin's name and a hyphen, such as blog-author. */
  name: string;
  label: string;
  description?: string;
  /** From the permission catalogue, such as "dashboard:access" or "ext.blog:moderate". */
  permissions?: Permission[];
  /** Record access by collection slug, such as { "blog-posts": ["create", "update:own"] }. */
  records?: Record<string, PluginRecordGrant[]>;
  /** "scoped" for a role a scope provider gives within one scope value. Default "instance". */
  scope?: "instance" | "scoped";
}

/** A field's words in other interface languages, by language code, for `schema.addFieldLabels`. */
export interface FieldLabels {
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  /** Each choice's label, by its value. */
  options?: Record<string, Record<string, string>>;
}

export interface PluginMigrationContext extends ExtensionContext {
  schema: ExtensionSchema & {
    /** Adds collections and fields from a portable schema document. It never removes anything. */
    apply(document: unknown): Promise<void>;
    /**
     * Adds fields an existing collection doesn't have yet, by name, leaving everything else as
     * its owner set it. For a plugin version that needs a new field. Returns whether it added any.
     */
    addFields(collection: string, fields: Array<{ name: string; type: string; config?: Record<string, unknown> }>): Promise<boolean>;
    /**
     * Adds choices a radio or select field doesn't offer yet, by value, after the ones it has.
     * Labels and order the owner set are kept. For a plugin version that needs a new choice.
     * Returns whether it added any, and false when the field is gone.
     */
    addOptions(collection: string, field: string, options: Array<{ label: string; value: string }>): Promise<boolean>;
    /**
     * Adds the collection's name in interface languages it has no name in yet, such as
     * `{ ar: "المقالات" }`. Names the owner set are kept. Returns whether it added any, and
     * false when the collection is gone.
     */
    addLabels(collection: string, labels: Record<string, string>): Promise<boolean>;
    /**
     * Adds fields' labels, descriptions and choice labels in interface languages they have
     * none in, by field name and then choice value, such as
     * `{ title: { labels: { ar: "العنوان" } }, state: { options: { draft: { ar: "مسودة" } } } }`.
     * Words the owner set are kept, and fields or choices the owner removed are skipped.
     * Returns whether it added any, and false when the collection is gone.
     */
    addFieldLabels(collection: string, fields: Record<string, FieldLabels>): Promise<boolean>;
    /**
     * The same for the fields of a block the plugin made with `apply`. A block in the plugin's
     * `blocks` takes its words from its code instead. Returns false when the block is gone.
     */
    addBlockFieldLabels(block: string, fields: Record<string, FieldLabels>): Promise<boolean>;
  };
  roles: {
    /**
     * Creates the role if there's no role by that name, and returns whether it did. An
     * existing role is left as the owner set it. Nobody holds it until someone assigns it.
     */
    ensure(role: PluginRole): Promise<boolean>;
  };
}

/** Runs once, in the order listed, at startup. Uses `system.records`, `store` and `schema`, never SQL. Add new ones at the end. */
export interface PluginMigration {
  id: string;
  up(context: PluginMigrationContext): void | Promise<void>;
}

interface SettingBase {
  /** Letters, digits and underscores, starting with a lowercase letter, such as passingScore. */
  name: string;
  label: string;
  description?: string;
  /**
   * Whether each scope value, such as a tenant, can have its own, layered over the instance's
   * (SECURITY_MODEL.md, "Row scopes"). Someone with the plugin's settings permission sets it
   * while working in that value. Without a scope provider it changes nothing. Settings a
   * better-auth plugin is built from apply instance-wide whatever this says.
   */
  perScope?: boolean;
}

/**
 * Choices a text setting offers while still taking any text, such as the models a provider
 * lists. The settings page asks `route`, a GET route of the same plugin such as "/models",
 * passing the current form values of the settings named in `with` as query parameters, and
 * expects `{ options: Array<{ value: string; label?: string }> }`. The route states its own
 * access, as every route does: usually the plugin's settings permission.
 */
export interface SettingSuggestions {
  route: string;
  /** Other settings, not secrets, whose unsaved values the route needs, such as "provider". */
  with?: string[];
}

/** One setting on a plugin's settings page. `default` applies until someone saves another value. */
export type PluginSettingField = SettingBase & (
  | { type: "boolean"; default: boolean }
  | { type: "number"; default: number; min?: number; max?: number; integer?: boolean }
  | { type: "text"; default: string; maxLength?: number; multiline?: boolean; suggestions?: SettingSuggestions }
  | { type: "select"; default: string; options: Array<{ label: string; value: string }> }
  /**
   * An API key or other secret. Stored encrypted, never sent back to the dashboard (it only
   * shows whether one is set) and never audited. When `env` names an environment variable
   * that is set, that value is used instead and the dashboard says so.
   */
  | { type: "secret"; env?: string; default?: undefined }
);

/**
 * Settings people change in the dashboard without a rebuild, unlike `options`. A plugin
 * usually takes its options as the defaults. Put secrets only in `secret` settings: whoever
 * holds the permission sees every other value.
 */
export interface PluginSettings {
  /** Needed to see and change them. "setting:update" when left out. */
  permission?: Permission;
  fields: PluginSettingField[];
}

/** The plugin contract this CMS provides. It changes only when an existing plugin would stop working. */
export const PLUGIN_API_VERSION = 1;

/**
 * Everything a plugin is, in one manifest. Trusted server code: see docs/EXTENDING.md.
 * Never imports React, so API routes don't either. `admin` names the React halves as
 * strings, and `tansy sync` turns those into imports.
 */
export interface CmsPlugin {
  /** Lowercase letters, digits and hyphens. Its field types and blocks start with this name. */
  name: string;
  /**
   * Splits records by a value this plugin resolves per request, such as a tenant. Only one
   * installed plugin can provide it. See "Row scopes" in SECURITY_MODEL.md.
   */
  scope?: ScopeProvider;
  version: string;
  /** PLUGIN_API_VERSION when the plugin was built. */
  apiVersion: number;
  /** A tansy version range, such as "^1.0.0". */
  requires?: { cms?: string };
  /** Module paths. `server` is for server components, `client` reaches the browser, and `render` holds front-end components with no server imports. */
  admin?: { server?: string; client?: string; render?: string };
  /** Outside origins the plugin's pages need. */
  csp?: CspAdditions;
  /** Checked at startup, so a wrong option stops the server instead of failing later. Secrets belong in environment variables. */
  options?: { schema: z.ZodType; value: unknown };
  /** Settings changed in the dashboard, read with `context.settings.get()`. */
  settings?: PluginSettings;
  /** Authentication features: sign-in providers, password checks, request guards, mail and audit forwarding. */
  auth?: AuthExtension;
  fields?: FieldDefinition[];
  /** Created at startup, and updated when the definition changes. */
  blocks?: PluginBlock[];
  /** New permission resources. Keys must start with "ext.". */
  permissions?: Record<string, readonly string[]>;
  /**
   * Which of those permissions a scoped role may hold, such as `["ext.multi-tenant:members"]`:
   * ones that act only inside the request's scope value. Never an `all` action. A route that
   * checks one must work on `principal.scope` alone. See "Row scopes" in SECURITY_MODEL.md.
   */
  scopedPermissions?: string[];
  hooks?: HookMap;
  routes?: ExtensionRoute[];
  /** What AI agents can do with this plugin, over MCP and through `context.tools`. */
  tools?: AgentTool[];
  /** `tansy` commands this plugin adds, such as `tansy tenant`. They reach the instance over HTTP, as the API key in TANSY_API_KEY. */
  commands?: PluginCommand[];
  /**
   * What `tansy doctor` should say about this plugin, such as an option of its own that gives
   * something up. It runs with no server and no database, and anything it reports is labelled with
   * the plugin's name.
   */
  doctor?(context: DoctorContext): DoctorCheck[] | Promise<DoctorCheck[]>;
  jobs?: JobDefinition[];
  /**
   * Components shown on every page of the site, such as an analytics tracker or a cookie
   * notice, by name: the render module's `everyPage` components of the same names. Each
   * name starts with the plugin's name and a hyphen. A component shows on a page only when
   * its function here returns props for it, which is where it reads settings.
   */
  everyPage?: Record<string, EveryPageFunction>;
  migrations?: PluginMigration[];
  /**
   * Its collections that only its own `system.records` may write, such as payments or the
   * members of a tenant, by slug. Nobody's role or API rule opens them: staff with record
   * permissions can read them, and the dashboard shows them read-only.
   */
  systemCollections?: string[];
  /**
   * The fields this plugin's code relies on, by collection slug, then field name and type,
   * such as `{ "blog-posts": { title: "text" } }`. Owners can still edit these collections.
   * Anything missing or retyped is shown under Dashboard → Extensions.
   */
  contract?: Record<string, Record<string, string>>;
  /**
   * Called after every API request with what happened, such as to keep a request log. It runs
   * as the response is sent, so it must only queue the entry and return, then write the queue
   * out later with `context`, from a timer of its own: every server gets requests, while a job
   * runs on one. It can't change the response. An error it throws is logged and ignored.
   */
  onRequest?: (request: ApiRequest, context: ExtensionContext) => void;
  /** Machine translation, offered as "Translate from …" in the record editor. It receives only text the person asking may read. */
  translator?: Translator;
  /**
   * The plugin's dashboard words, by language code, in ICU MessageFormat:
   * `{ en: { moderate: "Moderate" }, ar: { moderate: "إشراف" } }`. Its pages read them
   * with `useT()` from tansy/admin as `t("ext.<plugin>.moderate")`. English is the fallback.
   */
  messages?: Record<string, Messages>;
}

/**
 * What a plugin's `tansy` command talks to: its own routes on a **running server**, as the API key in
 * `TANSY_API_KEY`. The CLI never opens the database for a plugin, so everything a command does goes
 * through the same guard, permissions, rules and audit log as any other request, and a command can
 * only do what that key may do. Routes a person must sign in again for (`fresh`) are closed to it.
 */
export interface PluginCommandApi {
  /** The server this is talking to, for a message that names it. */
  readonly url: string;
  /** This plugin's route, under /api/ext/<plugin>, parsed as JSON. Throws with the server's own message. */
  request<T = unknown>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
  /** The same, as the raw response, for a route that answers with a file or takes one. */
  fetch(path: string, init?: { method?: string; body?: BodyInit; headers?: Record<string, string> }): Promise<Response>;
}

export interface PluginCommandContext {
  /** The words after the command's own name, so `tansy tenant suspend t_1` gives ["suspend", "t_1"]. */
  args: string[];
  /** The flags the CLI parsed, such as `--out`. */
  flags: Record<string, string | boolean | undefined>;
  api: PluginCommandApi;
  /** One line of output for the person running it. */
  log(line: string): void;
  /** Prints the message and stops with a failing exit code. */
  fail(message: string): never;
}

/**
 * A `tansy` command this plugin adds, such as `tansy tenant list`. Core dispatches by `name` without
 * knowing any plugin, refuses a name one of its own commands has, and refuses two plugins claiming
 * the same name. The command runs in the app's folder, with its `.env` loaded, and reaches the
 * instance only through `api`, which is a running server.
 */
export interface PluginCommand {
  /** One word, letters, digits and hyphens, which becomes `tansy <name>`. */
  name: string;
  /** One line, such as "cms tenant list | show <id> | suspend <id>". */
  usage: string;
  /** One line about what it is for, shown by `tansy` with no arguments. */
  describe: string;
  run(context: PluginCommandContext): void | Promise<void>;
}

/** One line of `tansy doctor`: a warning is something that works but gives something up. */
export interface DoctorCheck {
  ok: boolean;
  /** Said as what is true when it passes, such as "its DNS servers are addresses". */
  label: string;
  /** What to do about it, shown when it doesn't pass. */
  fix?: string;
  /** A warning rather than a failure, so `tansy doctor` still exits 0. */
  warning?: boolean;
}

/**
 * What a plugin's `doctor` gets. `tansy doctor` runs with no server and no database, so a check reads
 * the plugin's own options, the environment and the app's files, and nothing else.
 */
export interface DoctorContext {
  env: Record<string, string | undefined>;
  /** The app's folder, the one `tansy doctor` ran in. */
  cwd: string;
}

export const definePlugin = (plugin: CmsPlugin): CmsPlugin => plugin;

/** Wraps a `tansy` command so its context is typed. */
export const defineCommand = (command: PluginCommand): PluginCommand => command;

/** One block in code, for a plugin's `blocks`. */
export const defineBlock = (block: PluginBlock): PluginBlock => block;

/** Wraps a route so its `body` and `query` schemas type the handler. */
export const defineRoute = <B extends z.ZodType, Q extends z.ZodType>(route: ExtensionRoute<B, Q>) => route as unknown as ExtensionRoute;

/** Wraps an agent tool so its `input` schema types the handler. */
export const defineTool = <I extends z.ZodType>(tool: AgentTool<I>) => tool as unknown as AgentTool;

/** What a file in cms_hooks/ receives. Registrations take effect when the file finishes loading. */
export interface CmsHooks {
  on<E extends BeforeEvent>(event: E, hook: BeforeHook): void;
  on<E extends AfterEvent>(event: E, hook: AfterHook): void;
  on<E extends LifecycleEvent>(event: E, hook: LifecycleHook<E>): void;
  route(route: ExtensionRoute): void;
  job(job: JobDefinition): void;
}
