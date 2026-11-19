import "server-only";
import { invalidateSiteCache } from "../site/cache";
import { clearCollectionSearch } from "../search";
import { removeCollectionGrants } from "../authz/role-admin";
import { validateRule } from "../authz/rules/evaluate";
import { fieldStorage } from "../fields/registry";
import { HttpError, notFound } from "../http/errors";
import prisma from "../../lib/prisma";
import { createCollectionSchema, dropCollections, updateCollectionDetails, updateFieldSchema, type NewCollection } from "../schema/service";
import type { RequestedField } from "../schema/diff";
import { isLocalizedCollection } from "../i18n/context";
import type { Labels } from "../i18n/labels";

const include = { fields: { orderBy: { id: "asc" } } } as const;

export const listCollections = () => prisma.collection.findMany({ include, orderBy: { createdAt: "desc" } });

export const listCollectionNames = () =>
  prisma.collection.findMany({ select: { id: true, name: true, labels: true, type: true, scoped: true }, orderBy: { name: "asc" } });

export async function getCollection(id: number) {
  const collection = await prisma.collection.findUnique({ where: { id }, include });
  if (!collection) throw notFound("Collection");
  return collection;
}

export const createCollection = (input: NewCollection, createdById: string) => createCollectionSchema(input, createdById);

export const updateCollection = (id: number, data: { name?: string; labels?: Labels | null; slug?: string; description?: string; urlPattern?: string | null; reviewRequired?: boolean }, actorId: string) =>
  updateCollectionDetails(id, data, actorId);

export const updateFields = (id: number, fields: RequestedField[], confirm: boolean, actorId: string) =>
  updateFieldSchema(id, fields, confirm, actorId);

export async function deleteCollections(ids: number[], actorId: string) {
  await dropCollections(ids, actorId);
  await Promise.all([...ids.map(clearCollectionSearch), removeCollectionGrants(ids)]);
}

type Rules = Record<"listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule", string | null>;

export async function updateRules(id: number, rules: Rules) {
  const collection = await getCollection(id);
  if (collection.type === "view") {
    const writes = (["createRule", "updateRule", "deleteRule"] as const).filter((key) => rules[key] !== null).map((path) => ({ path, message: "View collections are read-only, so this rule must stay locked." }));
    if (writes.length) throw new HttpError(400, "INVALID_RULE", "One or more rules are invalid.", writes);
  }
  // A localized collection's rules can read the language a record is read in.
  const fieldNames = [...collection.fields.map((f) => f.name), ...(isLocalizedCollection(collection) ? ["locale"] : [])];
  const all = await prisma.collection.findMany({ select: { slug: true, fields: { select: { name: true } } } });
  const catalog = new Map(all.map((c) => [c.slug, new Set(c.fields.map((f) => f.name))]));
  const customAuth = (await prisma.userField.findMany({ select: { name: true } })).map((field) => field.name);
  // Only a JSON field holds values under it. Every other path leaving the record would follow a
  // relation, which a rule can't do, so it is refused here rather than denying every record later.
  const nested = new Set(collection.fields.filter((field) => fieldStorage(field).sql === "json").map((field) => field.name));
  const problems = Object.entries(rules).flatMap(([path, source]) => {
    const message = source ? validateRule(source, fieldNames, catalog, customAuth, nested) : null;
    return message ? [{ path, message }] : [];
  });
  if (problems.length) throw new HttpError(400, "INVALID_RULE", "One or more rules are invalid.", problems);
  const updated = await prisma.collection.update({ where: { id }, data: rules });
  // A tightened rule has to reach cached public reads at once.
  invalidateSiteCache();
  return updated;
}
