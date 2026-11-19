import "server-only";
import { collectionSlug } from "../authz/rules/evaluate";
import { decodeColumn, type ColumnType } from "../fields/define";
import { fieldStorage } from "../fields/registry";
import { tableName } from "../schema/names";
import prisma from "../../lib/prisma";
import { recordsDb } from "./db";
import { isLocalizedCollection } from "../i18n/context";
import { readSource } from "../i18n/storage";
import { trackCollectionRead } from "../site/cache";

export const SYSTEM_COLUMNS: ReadonlyArray<[string, ColumnType]> = [
  ["id", "integer"],
  ["status", "text"],
  ["createdAt", "datetime"],
  ["updatedAt", "datetime"],
  ["publishedAt", "datetime"],
  ["createdById", "text"],
];

const SYSTEM_KINDS = new Map(SYSTEM_COLUMNS);

/** Truncating could flip a rule's result, so a larger table denies instead. */
const MAX_LOOKUP_ROWS = 10_000;

/**
 * Serves @collection in API rules. Rules are written by administrators, so this
 * reads past the target collection's own rules on purpose. It is never reachable
 * from a caller's filter.
 */
export async function lookupCollectionValues(written: string, field: string): Promise<unknown[]> {
  const slug = collectionSlug(written);
  const collection = await prisma.collection.findUnique({ where: { slug }, include: { fields: true } });
  if (!collection) throw new Error(`Unknown collection "${slug}".`);

  let kind = SYSTEM_KINDS.get(field);
  if (!kind) {
    const stored = await prisma.field.findFirst({ where: { collectionId: collection.id, name: field }, select: { type: true, config: true, storage: true } });
    if (!stored) throw new Error(`Unknown field "${slug}.${field}".`);
    kind = fieldStorage(stored).sql;
  }

  // Both names were just found in the catalogue, so neither comes from the rule text alone.
  // A localized collection's values are read as a request naming no language reads them: one translation per record.
  // A rule reading another collection makes a cached site read depend on it too.
  trackCollectionRead(collection.id);
  const from = isLocalizedCollection(collection) ? await readSource(collection) : tableName(slug);
  const rows = await recordsDb.selectFrom(from).select(field).limit(MAX_LOOKUP_ROWS + 1).execute();
  if (rows.length > MAX_LOOKUP_ROWS) throw new Error(`"${slug}" has too many records for an @collection rule.`);
  return rows.map((row) => decodeColumn(kind, row[field]));
}
