import "server-only";
import type { Principal } from "../authz/principal";
import { validateRecordValues } from "../blocks/service";
import { withDefaults } from "../fields/validate";
import { fileActor } from "../files/refs";
import { badRequest } from "../http/errors";
import type { CollectionWithFields } from "./access";
import { createContent, deleteContent, updateContent, type WriteGuard } from "./content-service";
import { flattenRecord, type RecordRow } from "./records";

/** Checks a write against the collection's rule. Receives the record the rule sees, and the submitted values for @request.body. */
export type AuthorizeWrite = (record: Record<string, unknown>, values: Record<string, unknown>) => void;

/** Flat values by field name, as the public record API returns them. */
export function readFlatBody(collection: CollectionWithFields, body: Record<string, unknown> = {}) {
  const { status, ...values } = body;
  if (status !== undefined && status !== "draft" && status !== "published") throw badRequest("status must be draft or published.");
  const names = new Set(collection.fields.map((field) => field.name));
  const unknown = Object.keys(values).find((name) => !names.has(name));
  if (unknown) throw badRequest(`This collection has no field "${unknown.slice(0, 100)}".`);
  return { status: status as "draft" | "published" | undefined, values };
}

export const creatorOf = (principal: Principal) => (principal.kind === "anonymous" ? null : principal.user.id);

/** The rule runs before validation, so callers who may not write learn nothing about the schema. */
/** `owner` stands in for the writer as the record's creator, for system writes on someone's behalf. Check it before passing it. */
export async function createFlat(collection: CollectionWithFields, body: Record<string, unknown>, principal: Principal, authorize: AuthorizeWrite, owner?: string) {
  const { status, values } = readFlatBody(collection, body);
  const createdById = owner ?? creatorOf(principal);
  const candidate = withDefaults(collection.fields, values);
  authorize({ status: "draft", createdById: createdById ?? "", ...candidate }, values);
  return createContent(collection, status, await validateRecordValues(collection.fields, candidate), createdById, fileActor(principal));
}

export async function updateFlat(collection: CollectionWithFields, item: RecordRow, body: Record<string, unknown>, principal: Principal, authorize: AuthorizeWrite, expected?: string | WriteGuard) {
  const { status, values } = readFlatBody(collection, body);
  authorize(flattenRecord(item), values);
  return updateContent(collection, item, status, await validateRecordValues(collection.fields, values, item), fileActor(principal), undefined, expected);
}

export async function deleteFlat(collection: CollectionWithFields, item: RecordRow, principal: Principal, authorize: AuthorizeWrite) {
  authorize(flattenRecord(item), {});
  await deleteContent(collection, item.id, fileActor(principal));
}
