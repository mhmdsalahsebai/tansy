import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { Transaction } from "kysely";
import type { CollectionWithFields } from "./access";
import type { RecordRow } from "./records";

type Trx = Transaction<Record<string, Record<string, unknown>>>;

/** Per record. Older history is dropped so one busy record can't grow without limit. */
export const MAX_HISTORY = 100;

/** A localized record keeps history per language. Each revision holds the shared values and that language's. */
const history = (trx: Trx, collection: CollectionWithFields, recordId: number, locale: string) =>
  trx.selectFrom("Revision").where("collectionId", "=", collection.id).where("recordId", "=", recordId).where("locale", "=", locale).where("kind", "=", "history");

/** Keyed by field id, so renaming a field doesn't orphan old values. */
export const byFieldId = (collection: CollectionWithFields, row: Record<string, unknown>) =>
  Object.fromEntries(collection.fields.filter((field) => field.name in row).map((field) => [field.id, row[field.name] ?? null]));

/** Called after the record's write in the same transaction, so history can't disagree with the record. A save that changed nothing adds nothing. */
export async function snapshotRecord(trx: Trx, collection: CollectionWithFields, row: RecordRow, createdById: string | null, note?: string, locale = "") {
  const values = JSON.parse(JSON.stringify(byFieldId(collection, row)));
  const last = await history(trx, collection, row.id, locale).select(["number", "status", "values"]).orderBy("number", "desc").limit(1).executeTakeFirst();
  if (last && last.status === row.status && isDeepStrictEqual(JSON.parse(last.values as string), values)) return;

  const number = ((last?.number as number | undefined) ?? 0) + 1;
  await trx.insertInto("Revision").values({
    collectionId: collection.id, recordId: row.id, locale, kind: "history", number, status: row.status,
    values: JSON.stringify(values), createdById, note: note ?? null, createdAt: new Date().toISOString(),
  }).execute();
  await trx.deleteFrom("Revision").where("collectionId", "=", collection.id).where("recordId", "=", row.id).where("locale", "=", locale).where("kind", "=", "history").where("number", "<=", number - MAX_HISTORY).execute();
}

/** Records from before history existed get their prior state saved, so the first edit can still be undone. */
export async function ensureBaseline(trx: Trx, collection: CollectionWithFields, previous: RecordRow, locale = "") {
  if (await history(trx, collection, previous.id, locale).select("id").limit(1).executeTakeFirst()) return;
  await snapshotRecord(trx, collection, previous, previous.createdById, undefined, locale);
}
