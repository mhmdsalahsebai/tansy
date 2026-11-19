import "server-only";
import type { NextRequest } from "next/server";
import type { RuleLookups, RuleRequest } from "../authz/records";
import { notFound } from "../http/errors";
import prisma from "../../lib/prisma";
import type { CollectionLocale } from "../i18n/context";

export async function requireCollection(id: number) {
  const collection = await prisma.collection.findUnique({ where: { id }, include: { fields: { orderBy: { id: "asc" } } } });
  if (!collection) throw notFound("Collection");
  return collection;
}

/** `locale` says which language a localized collection is read in or written to. See core/i18n. */
export type CollectionWithFields = Awaited<ReturnType<typeof requireCollection>> & { locale?: CollectionLocale };

const withFields = { fields: { orderBy: { id: "asc" } } } as const;

export async function requireCollectionBySlug(slug: string) {
  const collection = await prisma.collection.findUnique({ where: { slug }, include: withFields });
  if (!collection) throw notFound("Collection");
  return collection;
}

export const allCollections = () => prisma.collection.findMany({ include: withFields });

export const ruleRequest = (request: NextRequest, query: Record<string, unknown>, body: Record<string, unknown>, lookups?: RuleLookups): RuleRequest => ({
  method: request.method,
  headers: request.headers,
  query,
  body,
  lookups,
});
