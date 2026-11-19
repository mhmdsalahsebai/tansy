import "server-only";
import { z } from "zod";
import { holdsOwnRecordPermission, holdsRecordPermission } from "../authz/permissions";
import { ownsRecord } from "../authz/records";
import type { Principal } from "../authz/principal";
import { badRequest, HttpError } from "../http/errors";
import type { CollectionWithFields } from "./access";

/** A record's `updatedAt` or a draft's `createdAt`, as an earlier read returned it. Saves carrying one fail if it is out of date. */
export const versionStamp = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "Must be a timestamp.");

export const recordChanged = () => new HttpError(409, "RECORD_CHANGED", "Someone else changed this record after you opened it.");

/** A conditional update found the record in another state, so nothing was written. */
export const conditionNotMet = () => new HttpError(409, "CONDITION_NOT_MET", "The record no longer matches the condition, so nothing was changed.");

/** Compares as moments, since Postgres and SQLite return timestamps in different forms. */
export const sameMoment = (a: unknown, b: unknown) => new Date(a as string).getTime() === new Date(b as string).getTime();

/** Reads the HTTP header for clients of the flat API, whose body holds only field names. */
export function ifMatchStamp(header: string | null): string | undefined {
  if (header === null) return undefined;
  const parsed = versionStamp.safeParse(header.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!parsed.success) throw badRequest('If-Match must be the record\'s updatedAt, such as "2026-01-15T10:00:00.000Z".');
  return parsed.data;
}

export type RecordRow = Record<string, unknown> & {
  id: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  createdById: string | null;
};

/** The shape API rules see: system columns plus field values by name. */
export const flattenRecord = (row: RecordRow): Record<string, unknown> => ({ ...row, createdById: row.createdById ?? "" });

/**
 * Hidden fields are for staff. Rules can still read them, since rules run on the server.
 * Given a record, an own read grant shows them on a record the caller created, as the
 * draft and revision routes do. Without one, as for filters, only `record:read` does.
 */
export function readableFields(collection: CollectionWithFields, principal: Principal, row?: Pick<RecordRow, "createdById">) {
  if (holdsRecordPermission(principal.permissions, "record:read", collection.id)) return collection.fields;
  if (row && holdsOwnRecordPermission(principal.permissions, "record:read", collection.id) && ownsRecord(principal, { createdById: row.createdById ?? "" })) return collection.fields;
  return collection.fields.filter((field) => (field.config as { hidden?: boolean } | null)?.hidden !== true);
}

/** The dashboard API's record format. Every readable field is listed, with null for no value. */
export function presentRecord(collection: CollectionWithFields, row: RecordRow, principal: Principal) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    createdById: row.createdById,
    ...(typeof row.locale === "string" ? { locale: row.locale, translated: Number(row._translated ?? 1) === 1 } : {}),
    values: readableFields(collection, principal, row).map((field) => ({ fieldId: field.id, value: row[field.name] ?? null, field })),
  };
}

export interface ContentInput {
  status?: "draft" | "published";
  values: Array<{ fieldId: number; value: unknown }>;
}

/** Rejects field ids from other collections, and returns the submitted values by field name. */
export function resolveValues(collection: CollectionWithFields, input: ContentInput) {
  const nameById = new Map(collection.fields.map((field) => [field.id, field.name]));
  const body: Record<string, unknown> = {};
  if (input.status) body.status = input.status;
  for (const { fieldId, value } of input.values) {
    const name = nameById.get(fieldId);
    if (!name) throw badRequest("A value refers to a field outside this collection.");
    body[name] = value;
  }
  return body;
}
