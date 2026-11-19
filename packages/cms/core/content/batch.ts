import "server-only";
import type { RecordAction } from "../authz/records";
import type { Principal } from "../authz/principal";
import { validateRecordValues } from "../blocks/service";
import { withDefaults } from "../fields/validate";
import { fileActor } from "../files/refs";
import { badRequest, HttpError } from "../http/errors";
import { emitRecordEvent, type RecordEvent } from "../realtime/hub";
import { allCollections, type CollectionWithFields } from "./access";
import { hasHooks, runBeforeHooks } from "../extend/hooks";
import { createRecordIn, deleteRecordIn, fieldError, hookedValues, requireContent, requireContentIn, toRecord, trashIntent, updateRecordIn } from "./content-service";
import { readFlatBody } from "./flat";
import { recordsDb } from "./db";
import { serializeRecordWrites } from "./locks";
import { parseId } from "./ids";
import { flattenRecord, type RecordRow } from "./records";
import { writingLocale } from "../i18n/request";

export interface BatchRequest {
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  body?: Record<string, unknown>;
}

export type BatchAuthorize = (collection: CollectionWithFields, action: Exclude<RecordAction, "list" | "view">, record: Record<string, unknown>, body: Record<string, unknown>, locale?: string) => void;

/** `?locale=fr` picks the language a localized collection's values go to, as on a single write. */
const TARGET = /^\/api\/collections\/([a-z0-9-]+)\/records(?:\/(\d{1,10}))?(?:\?locale=([A-Za-z0-9-]{1,35}))?$/;

async function target(request: BatchRequest, collections: CollectionWithFields[], principal: Principal) {
  const match = TARGET.exec(request.url);
  const found = match && collections.find((candidate) => candidate.slug === match[1]);
  if (!match || !found) throw badRequest("Use /api/collections/{collection}/records, with /{id} to update or delete.");
  const needsId = request.method !== "POST";
  if (needsId !== Boolean(match[2])) throw badRequest(needsId ? "This method needs a record id in the URL." : "Create requests take no record id.");
  const { collection, locale } = await writingLocale(found, principal, { locale: match[3] });
  return { collection, id: match[2] ? parseId(match[2]) : 0, locale };
}

function failure(index: number, error: unknown) {
  if (!(error instanceof HttpError)) throw error;
  return new HttpError(400, "BATCH_FAILED", "Batch transaction failed.", [{ index, status: error.status, code: error.code, message: error.message, details: error.details }]);
}

/**
 * Before-hooks can be slow, so they run first, outside the transaction, each
 * after its request passes the rule and validation. Inside the transaction those
 * checks run again on what the hooks returned.
 */
async function applyBeforeHooks(requests: BatchRequest[], collections: CollectionWithFields[], principal: Principal, authorize: BatchAuthorize) {
  if (!hasHooks("record.beforeCreate") && !hasHooks("record.beforeUpdate") && !hasHooks("record.beforeDelete")) return requests;
  const userId = principal.kind === "anonymous" ? null : principal.user.id;
  const actor = { userId, permissions: principal.permissions };
  const result: BatchRequest[] = [];
  for (const [index, request] of requests.entries()) {
    try {
      const { collection, id, locale } = await target(request, collections, principal);
      if (request.method === "DELETE") {
        const item = await requireContent(collection, id);
        authorize(collection, "delete", flattenRecord(item), {}, locale);
        await runBeforeHooks("record.beforeDelete", collection, { actor, values: {}, record: item });
        result.push(request);
        continue;
      }
      const { status, values } = readFlatBody(collection, request.body);
      let final: Record<string, unknown>;
      if (request.method === "POST") {
        const candidate = withDefaults(collection.fields, values);
        authorize(collection, "create", { status: "draft", createdById: userId ?? "", ...(locale ? { locale } : {}), ...candidate }, values, locale);
        final = await hookedValues("record.beforeCreate", collection, status, await validateRecordValues(collection.fields, candidate), actor);
      } else {
        const item = await requireContent(collection, id);
        authorize(collection, "update", flattenRecord(item), values, locale);
        final = await hookedValues("record.beforeUpdate", collection, status, await validateRecordValues(collection.fields, values, item), actor, item);
      }
      result.push({ ...request, body: { ...final, ...(status ? { status } : {}) } });
    } catch (error) {
      throw failure(index, error);
    }
  }
  return result;
}

/**
 * Runs every request in one transaction: all of them apply, or none do. Each
 * passes the same rule and validation as a single write. Events go out only
 * after the commit, so subscribers never see work that was rolled back.
 */
export async function runBatch(submitted: BatchRequest[], principal: Principal, authorize: BatchAuthorize) {
  const collections = await allCollections();
  const requests = await applyBeforeHooks(submitted, collections, principal, authorize);
  const actor = fileActor(principal);
  const createdById = principal.kind === "anonymous" ? null : principal.user.id;
  // Read before the transaction: deletes in a batch go to the trash as single ones do.
  const trash = requests.some((request) => request.method === "DELETE") ? await trashIntent(createdById) : null;

  const results = await recordsDb.transaction().execute(async (trx) => {
    // Later reads can't be overtaken by another writer. Batches also take turns, so two can't deadlock over the same records.
    await serializeRecordWrites(trx, "cms:batch");
    const done: Array<RecordEvent & { index: number }> = [];

    for (const [index, request] of requests.entries()) {
      let current: CollectionWithFields | undefined;
      try {
        const { collection, id, locale } = await target(request, collections, principal);
        current = collection;
        let row: Record<string, unknown>;
        let action: RecordEvent["action"];
        let previous: RecordRow | undefined;
        if (request.method === "POST") {
          const { status, values } = readFlatBody(collection, request.body);
          const candidate = withDefaults(collection.fields, values);
          authorize(collection, "create", { status: "draft", createdById: createdById ?? "", ...(locale ? { locale } : {}), ...candidate }, values, locale);
          row = await createRecordIn(trx, collection, status, await validateRecordValues(collection.fields, candidate), createdById, actor);
          action = "create";
        } else {
          const item = await requireContentIn(trx, collection, id);
          if (request.method === "PATCH") {
            const { status, values } = readFlatBody(collection, request.body);
            authorize(collection, "update", flattenRecord(item), values, locale);
            row = await updateRecordIn(trx, collection, item, status, await validateRecordValues(collection.fields, values, item), actor);
            action = "update";
            previous = item as RecordRow;
          } else {
            authorize(collection, "delete", flattenRecord(item), {}, locale);
            row = await deleteRecordIn(trx, collection, id, trash);
            action = "delete";
          }
        }
        done.push({ index, collection, action, row: await toRecord(collection, row) as RecordRow, previous });
      } catch (error) {
        throw failure(index, current ? fieldError(current, error) : error);
      }
    }
    return done;
  });

  for (const { collection, action, row, previous } of results) emitRecordEvent({ collection, action, row, previous });
  return results;
}
