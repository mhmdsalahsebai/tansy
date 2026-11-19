import "server-only";
import type { Collection } from "../../generated/client-sqlite";
import { lookupCollectionValues } from "../content/rule-lookup";
import { HttpError, notFound } from "../http/errors";
import { AUTH_RULE_FIELDS, collectionReferences, evaluateNode, evaluateRule, type CollectionLookup, type RuleContext } from "./rules/evaluate";
import type { RuleNode } from "./rules/parser";
import { ALLOW_ALL, compileRuleFilter, DENY_ALL, narrowingWhere, type RelationConditions, type RuleColumns, type RuleFilter } from "./rules/sql";
import { holdsOwnRecordPermission, holdsRecordPermission, type RecordPermission } from "./permissions";
import type { Principal } from "./principal";
import { systemCollectionOwner } from "../extend/system-collections";
import { SCOPE_COLUMN } from "../scope/context";

export type RecordAction = "list" | "view" | "create" | "update" | "delete";

const BYPASS: Record<RecordAction, RecordPermission> = {
  list: "record:list",
  view: "record:read",
  create: "record:create",
  update: "record:update",
  delete: "record:delete",
};

const RULE: Record<RecordAction, "listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule"> = {
  list: "listRule",
  view: "viewRule",
  create: "createRule",
  update: "updateRule",
  delete: "deleteRule",
};

/** Values for @collection, read before rules run. A failed read is kept as its error, which denies when the rule needs it. */
export type RuleLookups = ReadonlyMap<string, unknown[] | Error>;

export interface RuleRequest {
  method: string;
  headers: Headers;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  lookups?: RuleLookups;
  /** The language the request reads or writes, for `@request.locale`. */
  locale?: string;
}

function ruleRequest(principal: Principal, request: RuleRequest): RuleContext["request"] {
  // Built-in fields go last, so a custom value can never stand in for one.
  const auth = {
    ...principal.custom,
    ...Object.fromEntries(AUTH_RULE_FIELDS.map((field) => [field, principal.kind === "anonymous" ? "" : principal.user[field as keyof typeof principal.user]])),
  };
  return {
    auth,
    body: request.body,
    query: request.query,
    headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase().replaceAll("-", "_"), v])),
    method: request.method,
    context: "default",
    locale: request.locale ?? "",
    scope: principal.scope ?? "",
  };
}

const RULE_KEYS = Object.values(RULE);

/**
 * Reads what these collections' rules need from @collection, once, however many
 * records are then checked. Rules run synchronously and database drivers aren't,
 * so this comes first. A rule whose values weren't loaded denies.
 */
export async function loadRuleLookups(collections: Array<Pick<Collection, RuleKey>>): Promise<RuleLookups> {
  const wanted = new Map(collections.flatMap((collection) => RULE_KEYS.flatMap((key) => (collection[key] ? collectionReferences(collection[key]) : []))).map(([name, field]) => [`${name}.${field}`, [name, field] as const]));
  const entries = await Promise.all([...wanted].map(async ([key, [name, field]]) => [key, await lookupCollectionValues(name, field).catch((error: Error) => error)] as const));
  return new Map(entries);
}

function lookupFor(request: RuleRequest): CollectionLookup {
  return (collection, field) => {
    const values = request.lookups?.get(`${collection}.${field}`);
    if (values === undefined) throw new Error(`@collection.${collection}.${field} was not loaded.`);
    if (values instanceof Error) throw values;
    return values;
  };
}

export type RecordDecision = "allow" | "locked" | "denied";

type Target = Pick<Collection, "id" | "slug" | RuleKey>;

/** The role permission for this action, held for every collection or for this one. */
const bypasses = (principal: Principal, collection: Pick<Collection, "id">, action: RecordAction) =>
  holdsRecordPermission(principal.permissions, BYPASS[action], collection.id);

/** An own grant for this action. Creating has no record to own, so it never has one. */
const ownGrant = (principal: Principal, collection: Pick<Collection, "id">, action: RecordAction) =>
  action !== "create" && principal.kind !== "anonymous" && holdsOwnRecordPermission(principal.permissions, BYPASS[action], collection.id);

/**
 * A record from another scope value than the request's. The record layer already reads only
 * the request's own (core/scope/plugin.ts), so this is a second check on whatever reaches here.
 * Trusted server work has no scope of its own and is left to the record layer.
 */
function outOfScope(principal: Principal, record: Record<string, unknown>) {
  const scope = record[SCOPE_COLUMN];
  return typeof scope === "string" && principal.scope !== undefined && principal.scope !== scope;
}

/**
 * A plugin's system-owned collection (`systemCollections`): only that plugin's own
 * `system.records` writes it, whatever roles or rules say, and no API rule opens it.
 */
function systemOwner(collection: { slug: string }): string | null {
  return systemCollectionOwner(collection.slug);
}

/** Whether the caller created this record. A record nobody created is no one's. */
export const ownsRecord = (principal: Principal, record: Record<string, unknown>) =>
  principal.kind !== "anonymous" && principal.user.id !== "" && record.createdById === principal.user.id;

/** Whether only role permissions can do this, which needs no record and no rule evaluation. */
export function isLocked(principal: Principal, collection: Target, action: RecordAction): boolean {
  const owner = systemOwner(collection);
  if (owner !== null) return action === "list" || action === "view" ? !bypasses(principal, collection, action) : !ownsSystemCollection(principal, owner);
  return !bypasses(principal, collection, action) && !ownGrant(principal, collection, action) && collection[RULE[action]] === null;
}

const ownsSystemCollection = (principal: Principal, owner: string) => principal.kind === "anonymous" && principal.system === `plugin:${owner}`;

/**
 * Role permission wins (dashboard users), then an own grant on a record the caller
 * created, then the collection's API rule. With an own grant, a locked rule refuses
 * other people's records as "denied", so their existence isn't revealed.
 */
export function decideRecord(
  principal: Principal,
  collection: Target,
  action: RecordAction,
  record: Record<string, unknown>,
  request: RuleRequest,
): RecordDecision {
  // Row scopes come before every grant: another scope's record doesn't exist for this caller.
  if (outOfScope(principal, record)) return "denied";
  const owner = systemOwner(collection);
  if (owner !== null && action !== "list" && action !== "view") return ownsSystemCollection(principal, owner) ? "allow" : "locked";
  if (bypasses(principal, collection, action)) return "allow";
  // Role permissions alone read a system-owned collection: no own grant or rule opens it.
  if (owner !== null) return "locked";
  const own = ownGrant(principal, collection, action);
  if (own && ownsRecord(principal, record)) return "allow";
  const rule = collection[RULE[action]];
  if (rule === null) return own ? "denied" : "locked";
  if (rule === "") return "allow";
  return evaluateRule(rule, { record, request: ruleRequest(principal, request), lookup: lookupFor(request) }) ? "allow" : "denied";
}

type RuleKey = (typeof RULE)[RecordAction];

/** ownsRecord as a rule. Only reached for a signed-in caller, whose id is never empty. */
const OWN_RECORDS = '(@request.auth.id != "" && createdById = @request.auth.id)';

/** decideRecord for a whole list, as a WHERE expression. A locked rule matches nothing, so check for 403 first. */
export function listRuleWhere(
  principal: Principal,
  collection: Pick<Collection, "id" | "slug" | "listRule" | "type">,
  request: RuleRequest,
  columns: RuleColumns,
): RuleFilter {
  if (bypasses(principal, collection, "list")) return ALLOW_ALL;
  if (systemOwner(collection) !== null) return DENY_ALL;
  if (collection.listRule === "") return ALLOW_ALL;
  // An own grant adds the caller's records to whatever the rule shows, in the rule language so both databases agree.
  const source = ownGrant(principal, collection, "list")
    ? (collection.listRule === null ? OWN_RECORDS : `(${collection.listRule}) || ${OWN_RECORDS}`)
    : collection.listRule;
  if (source === null) return DENY_ALL;
  return compileRuleFilter(source, columns, { request: ruleRequest(principal, request), lookup: lookupFor(request) }, collection.type !== "view");
}

/** A caller's filter on one record, for realtime. Check it with validateFilter first. No lookup, so @collection is refused here too. */
export function matchesFilter(principal: Principal, filter: string, record: Record<string, unknown>, request: RuleRequest) {
  return evaluateRule(filter, { record, request: ruleRequest(principal, request) });
}

/**
 * A caller's filter, always combined with listRuleWhere. Check it with validateFilter first.
 * `relations` answers the paths that leave the record, such as `author.name`; without it
 * a filter holding one matches nothing (core/content/relations.ts).
 */
export function filterWhere(principal: Principal, collection: Pick<Collection, "type">, filter: string, request: RuleRequest, columns: RuleColumns, relations?: RelationConditions): RuleFilter {
  const ctx = { request: ruleRequest(principal, request), relations: relations?.holds };
  return compileRuleFilter(filter, columns, ctx, collection.type !== "view", relations?.where);
}

/**
 * Sound SQL for one condition, to narrow which records of a collection are read before
 * `matchesCondition` judges them (core/content/relations.ts). It can only exclude rows that
 * condition would have rejected, so it decides how much is read, never the answer. Null when
 * nothing can be pushed down. Rule contexts are built here, as they are for every other check.
 */
export function narrowingFor(principal: Principal, node: RuleNode, columns: RuleColumns, request: RuleRequest) {
  return narrowingWhere(node, columns, { request: ruleRequest(principal, request) });
}

/**
 * Whether one comparison holds for a record of the collection it names. Used to resolve a
 * relation path against the target collection before a query runs: the answer comes from the
 * evaluator, so it means the same on both databases. No lookup, so @collection is refused here too.
 */
export function matchesCondition(principal: Principal, node: RuleNode, record: Record<string, unknown>, request: RuleRequest): boolean {
  try {
    return evaluateNode(node, { record, request: ruleRequest(principal, request) });
  } catch (error) {
    console.error("[rules] evaluation failed; denying", error);
    return false;
  }
}

/**
 * Enforces a decision with PocketBase's status codes: locked is 403, a failed
 * create is 400, and failed view, update or delete are 404 so a caller cannot
 * learn that the record exists. Listing filters instead, see routes.
 */
export function authorizeRecord(
  principal: Principal,
  collection: Target,
  action: Exclude<RecordAction, "list">,
  record: Record<string, unknown>,
  request: RuleRequest,
): void {
  const decision = decideRecord(principal, collection, action, record, request);
  if (decision === "allow") return;
  if (decision === "locked") throw new HttpError(403, "RULE_LOCKED", "Only administrators can perform this action.");
  if (action === "create") throw new HttpError(400, "RULE_REJECTED", "The record could not be created.");
  throw notFound("Record");
}
