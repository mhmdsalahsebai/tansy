import "server-only";
import { labelIn } from "../i18n/labels";
import { listAudit } from "../audit/query";
import { decideRecord, listRuleWhere, loadRuleLookups, type RuleRequest } from "../authz/records";
import { holdsRecordPermission, holdsRecordPermissionAnywhere, holdsRecordPermissionForSome } from "../authz/permissions";
import type { Principal } from "../authz/principal";
import { valueSummary } from "../fields/registry";
import prisma from "../../lib/prisma";
import { allCollections, type CollectionWithFields } from "./access";
import { findRecordsById, listContentPage, ownedRecordIds, recordColumns } from "./content-service";
import { flattenRecord, readableFields, type RecordRow } from "./records";
import { scopedCollectionIds } from "../scope/registry";
import { withScope } from "../scope/context";

export interface OverviewRecord {
  collectionId: number;
  collection: string;
  id: number;
  title: string;
  status: string;
  updatedAt: string;
}

export interface OverviewData {
  /** Null when the caller can't read records, so the page leaves the record sections out. */
  content: {
    collections: Array<{ id: number; name: string; type: string; total: number; singletonId: number | null; canCreate: boolean }>;
    recent: OverviewRecord[];
    drafts: Array<OverviewRecord & { savedAt: string }>;
    scheduled: Array<OverviewRecord & { action: string; at: string; error: string | null }>;
    counts: { drafts: number; scheduled: number; failed: number };
  } | null;
  activity: Array<{ id: string; action: string; outcome: string; actor: string | null; at: string }> | null;
}

const RECENT = 8;
const QUEUE = 5;
const ACTIVITY = 6;
/** Where only an own grant applies, drafts and schedules are counted over this many of the person's latest records. */
const OWNED = 5_000;

/** The first readable field with a one-line summary, as the record grid shows it. */
export function titleOf(collection: CollectionWithFields, row: RecordRow, principal: Principal) {
  for (const field of readableFields(collection, principal)) {
    const value = row[field.name];
    // Plain text has no summary of its own, and is usually what names a record.
    const text = (valueSummary(field, value) ?? (field.type === "text" && typeof value === "string" ? value.slice(0, 120) : undefined))?.trim();
    if (text) return text;
  }
  // The dashboard words an untitled record in the reader's language.
  return "";
}

const asRecord = (collection: CollectionWithFields, row: RecordRow, principal: Principal, locale: string): OverviewRecord => ({
  collectionId: collection.id,
  collection: labelIn(collection, collection.name, locale),
  id: row.id,
  title: titleOf(collection, row, principal),
  status: row.status,
  updatedAt: row.updatedAt,
});

/**
 * What the dashboard home shows. Records come from the same list filter and view
 * check as the API, and drafts and schedules need record:read as their routes do.
 */
/** `locale` is the interface language, for collection names. */
export async function loadOverview(principal: Principal, headers: Headers, locale: string): Promise<OverviewData> {
  // Collections where record:read is held only for some are narrowed in loadContent.
  const canRecords = principal.permissions.has("collection:read") && holdsRecordPermissionAnywhere(principal.permissions, "record:read");
  const [content, activity] = await Promise.all([
    // In the scope value the page resolved. With none, scoped collections are left out, since they have no records to show.
    canRecords ? withScope(principal.scope ?? null, () => loadContent(principal, headers, locale)) : null,
    principal.permissions.has("audit:read") ? loadActivity() : null,
  ]);
  return { content, activity };
}

async function loadActivity() {
  const { items } = await listAudit({ page: 1, perPage: ACTIVITY });
  return items.map((item) => ({ id: item.id, action: item.action, outcome: item.outcome, actor: item.actorEmail, at: item.at.toISOString() }));
}

async function loadContent(principal: Principal, headers: Headers, locale: string) {
  // Views have no edits or drafts of their own. Drafts and schedules need record:read, for the collection or as an own grant.
  const outside = principal.scope ? new Set<number>() : scopedCollectionIds();
  const collections = (await allCollections()).filter((collection) => collection.type !== "view" && !outside.has(collection.id) && holdsRecordPermissionForSome(principal.permissions, "record:read", collection.id)).sort((a, b) => a.name.localeCompare(b.name));
  const lookups = await loadRuleLookups(collections);
  const request: RuleRequest = { method: "GET", headers, query: {}, body: {}, lookups };
  const visible = (collection: CollectionWithFields, row: RecordRow) => decideRecord(principal, collection, "view", flattenRecord(row), request) === "allow";

  const listed = await Promise.all(collections.map(async (collection) => {
    if (decideRecord(principal, collection, "list", {}, request) === "locked") return { collection, total: 0, rows: [] as RecordRow[] };
    const page = await listContentPage(collection, listRuleWhere(principal, collection, request, recordColumns(collection)), { page: 1, perPage: RECENT });
    return { collection, total: page.totalItems, rows: page.items.filter((row) => visible(collection, row)) };
  }));

  const recent = listed
    .flatMap(({ collection, rows }) => rows.map((row) => asRecord(collection, row, principal, locale)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT);

  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  // With only an own grant, drafts and schedules of other people's records aren't counted, or the totals would describe them.
  const full = collections.filter((collection) => holdsRecordPermission(principal.permissions, "record:read", collection.id));
  const userId = principal.kind === "anonymous" ? null : principal.user.id;
  const ownOnly = userId ? collections.filter((collection) => !full.includes(collection)) : [];
  const owned = await Promise.all(ownOnly.map(async (collection) => ({ collectionId: collection.id, recordId: { in: await ownedRecordIds(collection, userId!, OWNED) } })));
  // Drafts and schedules of scoped collections carry no scope of their own, so they're counted by whether their record is in this one.
  const scoped = scopedCollectionIds();
  const split = (ids: number[]) => ({ plain: ids.filter((id) => !scoped.has(id)), scoped: ids.filter((id) => scoped.has(id)) });
  const fullIds = split(full.map((collection) => collection.id));
  const plainOwned = owned.filter((entry) => !scoped.has(entry.collectionId));
  const scopedOwned = owned.filter((entry) => scoped.has(entry.collectionId));
  const inScope = { OR: [{ collectionId: { in: full.map((collection) => collection.id) } }, ...owned] };
  const plain = { OR: [{ collectionId: { in: fullIds.plain } }, ...plainOwned] };
  const scopedWhere = { OR: [{ collectionId: { in: fullIds.scoped } }, ...scopedOwned] };
  const [draftRows, scheduleRows, plainDrafts, plainScheduled, plainFailed, scopedDrafts, scopedSchedules] = await Promise.all([
    prisma.revision.findMany({ where: { kind: "draft", ...inScope }, orderBy: { createdAt: "desc" }, take: QUEUE * 4 }),
    prisma.scheduledAction.findMany({ where: inScope, orderBy: [{ failedAt: { sort: "desc", nulls: "last" } }, { at: "asc" }], take: QUEUE * 4 }),
    prisma.revision.count({ where: { kind: "draft", ...plain } }),
    prisma.scheduledAction.count({ where: { failedAt: null, ...plain } }),
    prisma.scheduledAction.count({ where: { failedAt: { not: null }, ...plain } }),
    fullIds.scoped.length || scopedOwned.length ? prisma.revision.findMany({ where: { kind: "draft", ...scopedWhere }, select: { collectionId: true, recordId: true } }) : [],
    fullIds.scoped.length || scopedOwned.length ? prisma.scheduledAction.findMany({ where: scopedWhere, select: { collectionId: true, recordId: true, failedAt: true } }) : [],
  ]);
  const inThisScope = await rowsFor([...scopedDrafts, ...scopedSchedules], byId);
  const here = (entry: { collectionId: number; recordId: number }) => inThisScope.has(`${entry.collectionId}:${entry.recordId}`);
  const drafts = plainDrafts + scopedDrafts.filter(here).length;
  const scheduled = plainScheduled + scopedSchedules.filter((entry) => !entry.failedAt && here(entry)).length;
  const failed = plainFailed + scopedSchedules.filter((entry) => entry.failedAt && here(entry)).length;
  const records = await rowsFor([...draftRows, ...scheduleRows], byId);
  const recordOf = (collectionId: number, recordId: number) => {
    const collection = byId.get(collectionId);
    const row = records.get(`${collectionId}:${recordId}`);
    return collection && row && visible(collection, row) ? asRecord(collection, row, principal, locale) : null;
  };

  return {
    collections: listed.map(({ collection, total, rows }) => ({ id: collection.id, name: labelIn(collection, collection.name, locale), type: collection.type, total, singletonId: collection.type === "singleton" ? (rows[0]?.id ?? null) : null, canCreate: holdsRecordPermission(principal.permissions, "record:create", collection.id) })),
    recent,
    drafts: draftRows.flatMap((draft) => {
      const record = recordOf(draft.collectionId, draft.recordId);
      return record ? [{ ...record, savedAt: draft.createdAt.toISOString() }] : [];
    }).slice(0, QUEUE),
    scheduled: scheduleRows.flatMap((entry) => {
      const record = recordOf(entry.collectionId, entry.recordId);
      return record ? [{ ...record, action: entry.action, at: entry.at.toISOString(), error: entry.failedAt ? entry.error ?? "Failed." : null }] : [];
    }).slice(0, QUEUE),
    counts: { drafts, scheduled, failed },
  };
}

async function rowsFor(entries: Array<{ collectionId: number; recordId: number }>, byId: Map<number, CollectionWithFields>) {
  const wanted = new Map<number, Set<number>>();
  for (const { collectionId, recordId } of entries) wanted.set(collectionId, (wanted.get(collectionId) ?? new Set()).add(recordId));
  const found = new Map<string, RecordRow>();
  await Promise.all([...wanted].map(async ([collectionId, ids]) => {
    const collection = byId.get(collectionId);
    if (!collection) return;
    for (const row of await findRecordsById(collection, [...ids])) found.set(`${collectionId}:${row.id}`, row);
  }));
  return found;
}
