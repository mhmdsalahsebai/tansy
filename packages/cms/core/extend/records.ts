import "server-only";
import { authorizeRecord, decideRecord, isLocked, loadRuleLookups, type RuleLookups, type RuleRequest } from "../authz/records";
import type { Principal } from "../authz/principal";
import { requireCollectionBySlug } from "../content/access";
import { recordMatches, requireContent, type MatchValue } from "../content/content-service";
import { createFlat, deleteFlat, updateFlat } from "../content/flat";
import { listRecords, viewRecord } from "../content/public-records";
import { recordListQuery, recordViewQuery } from "../content/query";
import { flattenRecord, readableFields, type RecordRow } from "../content/records";
import { audit } from "../audit";
import { badRequest, HttpError } from "../http/errors";
import prisma from "../../lib/prisma";
import type { RecordsApi } from "./define";
import { readingLocale, writingLocale } from "../i18n/request";
import { currentScope, withScope } from "../scope/context";

const userExists = async (id: string) => id.length > 0 && id.length <= 64 && (await prisma.user.count({ where: { id } })) > 0;

const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(result.error.issues[0].message);
  return result.data;
};

/**
 * Every serving path a plugin, hook or MCP tool has to records. Each one passes
 * authorizeRecord or decideRecord for this principal. `actor` names the extension
 * behind a system write, which has no person to attribute it to.
 */
export function scopedRecords(principal: Principal, headers: Headers = new Headers(), actor?: string): RecordsApi {
  const attribute = (action: "create" | "update" | "delete", slug: string, id: unknown, owner?: string) => {
    if (actor) void audit({ action: `record.${action}`, outcome: "success", actorKind: "system", actorEmail: actor, targetType: "record", targetId: `${slug}/${String(id)}`, metadata: { collection: slug, ...(owner ? { owner } : {}) } });
  };

  /** Only a system write may name another creator, and only one who exists. */
  const ownerOf = async (options?: { owner?: string }) => {
    if (options?.owner === undefined) return undefined;
    if (!actor) throw badRequest("Only system.records can create a record for someone else.");
    if (typeof options.owner !== "string" || !(await userExists(options.owner))) throw badRequest("The owner must be an existing user's id.");
    return options.owner;
  };

  const context = (lookups: RuleLookups, method: string, query: Record<string, unknown>, body: Record<string, unknown>, locale?: string): RuleRequest => ({ method, headers, query, body, lookups, locale });

  const present = async (slug: string, row: RecordRow, request: RuleRequest, locale?: string) => {
    const collection = (await writingLocale(await requireCollectionBySlug(slug), principal, { locale })).collection;
    return decideRecord(principal, collection, "view", flattenRecord(row), request) === "allow" ? viewRecord(collection, row, {}, principal, request) : { id: row.id };
  };

  /** A condition may name only fields this caller can read, so it can't be used to probe hidden values. Unknown and unreadable fields get the same answer. */
  const readableCondition = (collection: Awaited<ReturnType<typeof requireCollectionBySlug>>, item: RecordRow, condition: unknown): Record<string, MatchValue> => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw badRequest("`if` must be an object of field names and values.");
    const readable = new Set(readableFields(collection, principal, item).map((field) => field.name));
    for (const name of Object.keys(condition)) {
      if (name !== "status" && !readable.has(name)) throw badRequest(`A condition can't use "${name}". Use a text, number, boolean or select field, or status.`);
    }
    return condition as Record<string, MatchValue>;
  };

  const records: RecordsApi = {
    async list(slug, raw = {}) {
      const query = parse(recordListQuery, raw);
      const { collection, locale } = await readingLocale(await requireCollectionBySlug(slug), principal, query);
      const request = context(await loadRuleLookups([collection]), "GET", query, {}, locale);
      if (isLocked(principal, collection, "list")) throw new HttpError(403, "RULE_LOCKED", "Only administrators can perform this action.");
      return listRecords(collection, query, principal, request);
    },
    async get(slug, id, raw = {}) {
      const query = parse(recordViewQuery, raw);
      const { collection, locale } = await readingLocale(await requireCollectionBySlug(slug), principal, query);
      const row = await requireContent(collection, id);
      const request = context(await loadRuleLookups([collection]), "GET", query, {}, locale);
      authorizeRecord(principal, collection, "view", flattenRecord(row), request);
      return viewRecord(collection, row, query, principal, request);
    },
    async create(slug, data, options) {
      const { collection, locale } = await writingLocale(await requireCollectionBySlug(slug), principal, { locale: options?.locale });
      const owner = await ownerOf(options);
      const lookups = await loadRuleLookups([collection]);
      const row = await createFlat(collection, data, principal, (record, values) => authorizeRecord(principal, collection, "create", { ...record, ...(locale ? { locale } : {}) }, context(lookups, "POST", {}, values, locale)), owner);
      attribute("create", slug, row.id, owner);
      return present(slug, row, context(lookups, "POST", {}, data, locale), locale);
    },
    async update(slug: string, id: number, data: Record<string, unknown>, options?: { if?: Record<string, MatchValue>; locale?: string }) {
      const { collection, locale } = await writingLocale(await requireCollectionBySlug(slug), principal, { locale: options?.locale });
      const item = await requireContent(collection, id);
      const lookups = await loadRuleLookups([collection]);
      const authorize = (record: Record<string, unknown>, values: Record<string, unknown>) => authorizeRecord(principal, collection, "update", record, context(lookups, "PATCH", {}, values, locale));
      let row: RecordRow;
      if (options?.if === undefined) {
        row = await updateFlat(collection, item, data, principal, authorize);
      } else {
        const match = readableCondition(collection, item, options.if);
        // Checked on the record as read first, so a write that can't apply never runs before-hooks. The UPDATE checks again, which is what settles a race.
        if (!recordMatches(collection, item, match)) return null;
        try {
          row = await updateFlat(collection, item, data, principal, authorize, { match });
        } catch (error) {
          if (error instanceof HttpError && error.code === "CONDITION_NOT_MET") return null;
          throw error;
        }
      }
      attribute("update", slug, id);
      return present(slug, row, context(lookups, "PATCH", {}, data, locale), locale);
    },
    async delete(slug, id) {
      const collection = await requireCollectionBySlug(slug);
      const item = await requireContent(collection, id);
      const lookups = await loadRuleLookups([collection]);
      await deleteFlat(collection, item, principal, (record) => authorizeRecord(principal, collection, "delete", record, context(lookups, "DELETE", {}, {})));
      attribute("delete", slug, id);
    },
  } as RecordsApi;
  // A dashboard page has no scope of its own to run in, so the principal's value, which the page resolved, goes with each call.
  if (principal.scope === undefined) return records;
  const scope = principal.scope;
  const inScope = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => (...args: A) => {
    const state = currentScope();
    return state?.kind === "value" && state.value === scope ? call(...args) : withScope(scope, () => call(...args));
  };
  return Object.fromEntries(Object.entries(records).map(([name, call]) => [name, inScope(call as (...args: unknown[]) => Promise<unknown>)])) as unknown as RecordsApi;
}
