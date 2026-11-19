import "server-only";
import { createHash } from "node:crypto";
import { decideRecord, loadRuleLookups, type RuleRequest } from "../authz/records";
import type { Principal } from "../authz/principal";
import { loadBlockCatalog } from "../blocks/service";
import type { CollectionWithFields } from "../content/access";
import { findRecordsById, updateContent } from "../content/content-service";
import { recordsDb } from "../content/db";
import { findDraftValues, saveDraft } from "../content/revisions";
import { flattenRecord, readableFields, type RecordRow } from "../content/records";
import type { FileActor } from "../files/refs";
import { HttpError } from "../http/errors";
import { tableName } from "../schema/names";
import { localizedFields } from "./context";
import { localeCatalog } from "./locales";
import { applySegments, extractSegments, isTranslatableType, type Segment, type SegmentCatalog } from "./segments";
import { translationsOf, withLocale } from "./storage";
import { readXliff, writeXliff, type XliffRecord } from "./xliff";

export const MAX_EXCHANGE_RECORDS = 500;

const onlyIn = (collection: CollectionWithFields, code: string, missing: "absent" | "empty" = "absent") => withLocale(collection, { code, chain: [code], missing });
const isHidden = (field: { config: unknown }) => (field.config as { hidden?: boolean } | null)?.hidden === true;

/** Hash of the source text, so an import can tell whether the source changed after export. */
export const segmentsHash = (segments: Segment[]) => createHash("sha256").update(JSON.stringify(segments.map(({ id, text }) => [id, text]))).digest("hex").slice(0, 32);

interface Context {
  collection: CollectionWithFields;
  principal: Principal;
  request: RuleRequest;
  from: string;
  to: string;
}

function assertPair(collection: CollectionWithFields, from: string, to: string, catalog: Awaited<ReturnType<typeof localeCatalog>>) {
  if (!localizedFields(collection).length) throw new HttpError(400, "NOT_LOCALIZED", "This collection has no localized fields.");
  if (from === to) throw new HttpError(400, "BAD_REQUEST", "Choose two different languages.");
  for (const code of [from, to]) if (!catalog.has(code)) throw new HttpError(400, "INVALID_LOCALE", `${code} isn't one of this site's languages.`);
}

/** The localized, readable, non-hidden text fields: what may leave the site for translation. */
async function exchangeFields(collection: CollectionWithFields, principal: Principal, row: RecordRow): Promise<{ fields: CollectionWithFields["fields"]; catalog: SegmentCatalog }> {
  const readable = new Set(readableFields(collection, principal, row).map((field) => field.name));
  const fields = localizedFields(collection).filter((field) => readable.has(field.name) && isTranslatableType(field.type) && !isHidden(field));
  return { fields, catalog: fields.some((field) => field.type === "stream") ? await loadBlockCatalog() : new Map() };
}

/** Rows in `code` the caller may view, by id. */
async function viewable({ collection, principal, request }: Context, code: string, ids: number[]) {
  const source = onlyIn(collection, code);
  const rows = await findRecordsById(source, ids);
  return new Map(rows.filter((row) => decideRecord(principal, source, "view", flattenRecord(row), { ...request, locale: code }) === "allow").map((row) => [row.id, row]));
}

/**
 * An XLIFF 2.0 file of these records' text in `from`, with any existing `to` translation as
 * targets. Records the caller can't view in `from` are left out. Without ids, the collection's
 * first records up to the limit.
 */
export async function exportXliff(collection: CollectionWithFields, from: string, to: string, ids: number[] | null, principal: Principal, request: RuleRequest) {
  const catalog = await localeCatalog();
  assertPair(collection, from, to, catalog);
  const wanted = ids ?? (await recordsDb.selectFrom(tableName(collection.slug)).select("id").orderBy("id").limit(MAX_EXCHANGE_RECORDS).execute()).map((row) => row.id as number);
  if (wanted.length > MAX_EXCHANGE_RECORDS) throw new HttpError(400, "TOO_MANY", `Export at most ${MAX_EXCHANGE_RECORDS} records at a time.`);
  const context = { collection, principal, request: { ...request, lookups: request.lookups ?? (await loadRuleLookups([collection])) }, from, to };
  const [sources, targets] = await Promise.all([viewable(context, from, wanted), viewable(context, to, wanted)]);
  const records: XliffRecord[] = [];
  for (const id of wanted) {
    const row = sources.get(id);
    if (!row) continue;
    const { fields, catalog: blocks } = await exchangeFields(collection, principal, row);
    const segments = extractSegments(fields, row, blocks);
    if (!segments.length) continue;
    const existing = targets.get(id);
    const translated = existing ? new Map(extractSegments(fields, existing, blocks).map((segment) => [segment.id, segment.text])) : new Map<string, string>();
    records.push({ collection: collection.slug, id, sourceHash: segmentsHash(segments), segments: segments.map((segment) => ({ ...segment, ...(translated.has(segment.id) ? { target: translated.get(segment.id) } : {}) })) });
  }
  return { xliff: writeXliff(records, from, to), count: records.length, fields: [...new Set(records.flatMap((record) => record.segments.map((segment) => segment.id.split(/[/#]/)[0])))] };
}

export interface ImportResult {
  id: number;
  outcome: "saved" | "draft" | "skipped";
  reason?: string;
}

/**
 * Reads a translated XLIFF file back as drafts in its target language, through the same
 * write path as the editor: rules, language rights, validation and history all apply.
 * A record whose source text changed after export is skipped, so an old file can't undo
 * newer work. A published translation gets a pending draft rather than going live.
 */
export async function importXliff(collection: CollectionWithFields, xml: string, principal: Principal, request: RuleRequest, actor: FileActor) {
  let parsed;
  try {
    parsed = readXliff(xml);
  } catch (error) {
    throw new HttpError(400, "INVALID_XLIFF", (error as Error).message);
  }
  const catalog = await localeCatalog();
  assertPair(collection, parsed.from, parsed.to, catalog);
  const records = parsed.records.filter((record) => record.collection === collection.slug);
  if (records.length > MAX_EXCHANGE_RECORDS) throw new HttpError(400, "TOO_MANY", `Import at most ${MAX_EXCHANGE_RECORDS} records at a time.`);
  const context = { collection, principal, request: { ...request, lookups: request.lookups ?? (await loadRuleLookups([collection])) }, from: parsed.from, to: parsed.to };
  const sources = await viewable(context, parsed.from, records.map((record) => record.id));
  const target = onlyIn(collection, parsed.to, "empty");
  const results: ImportResult[] = [];

  for (const record of records) {
    const source = sources.get(record.id);
    if (!source) {
      results.push({ id: record.id, outcome: "skipped", reason: "not found" });
      continue;
    }
    const { fields, catalog: blocks } = await exchangeFields(collection, principal, source);
    const segments = extractSegments(fields, source, blocks);
    if (record.sourceHash !== segmentsHash(segments)) {
      results.push({ id: record.id, outcome: "skipped", reason: "source changed since export" });
      continue;
    }
    const [item] = await findRecordsById(target, [record.id]);
    if (!item || decideRecord(principal, target, "update", flattenRecord(item), { ...context.request, locale: parsed.to }) !== "allow") {
      results.push({ id: record.id, outcome: "skipped", reason: "not allowed" });
      continue;
    }
    const values = applySegments(fields, source, blocks, record.targets);
    try {
      const existing = (await translationsOf(collection, record.id)).find((translation) => translation.locale === parsed.to);
      if (existing?.status === "published") {
        // Keep whatever else the pending draft already holds.
        const pending = await findDraftValues(target, record.id);
        const merged = { ...pending, ...values };
        await saveDraft(target, item, { values: fields.filter((field) => field.name in merged).map((field) => ({ fieldId: field.id, value: merged[field.name] })) }, actor);
        results.push({ id: record.id, outcome: "draft" });
      } else {
        await updateContent(target, item, "draft", values, actor, "Imported from XLIFF");
        results.push({ id: record.id, outcome: "saved" });
      }
    } catch (error) {
      results.push({ id: record.id, outcome: "skipped", reason: error instanceof HttpError ? error.message : "could not be saved" });
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return { from: parsed.from, to: parsed.to, results };
}
