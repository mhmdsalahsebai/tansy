import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { loadBlockCatalog } from "../blocks/service";
import { mapFieldValues, type Block, type BlockCatalog } from "../blocks/stream";
import { allCollections, type CollectionWithFields } from "../content/access";
import { recordsAfter, reindexCollection, rewriteRecordValues, type Trx } from "../content/content-service";
import { recordsDb } from "../content/db";
import { isIndexed } from "../search/extract";
import { upgradedValue, type FieldDefinition } from "./define";
import { versionedFieldTypes } from "./registry";
import { isEmpty, type FieldLike } from "./validate";

const BATCH = 200;

interface Run {
  definition: FieldDefinition;
  from: number;
  to: number;
  batch: number;
}

function changedValues(run: Run, fields: FieldLike[], row: Record<string, unknown>, catalog: BlockCatalog) {
  const { definition, from, to } = run;
  const upgrade = (field: FieldLike, value: unknown) => upgradedValue(definition, (field.config ?? {}) as Record<string, unknown>, value, from, to);
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const stored = row[field.name];
    if (isEmpty(stored)) continue;
    const next = field.type === definition.type ? upgrade(field, stored) : Array.isArray(stored) ? mapFieldValues(stored as Block[], catalog, definition.type, upgrade) : stored;
    if (!isDeepStrictEqual(next, stored)) values[field.name] = next;
  }
  return values;
}

async function upgradeBatch(trx: Trx, run: Run, collection: CollectionWithFields, fields: FieldLike[], after: number, catalog: BlockCatalog) {
  const { type } = run.definition;
  const rows = await recordsAfter(trx, collection, after, run.batch);
  for (const row of rows) {
    try {
      const values = changedValues(run, fields, row, catalog);
      if (Object.keys(values).length) await rewriteRecordValues(trx, collection, row, values, catalog);
    } catch (error) {
      throw new Error(`Field type "${type}": could not upgrade record ${row.id} in "${collection.slug}" from version ${run.from}. ${(error as Error).message}`, { cause: error });
    }
  }
  const last = rows.at(-1)?.id ?? after;
  // In the same transaction as the rows, so the saved place always matches what was written.
  await trx.updateTable("FieldValueState").set({ cursorCollection: collection.id, cursorRecord: last }).where("type", "=", type).execute();
  return { last, more: rows.length === run.batch };
}

async function rewriteStoredValues(run: Run, start: { collection: number; record: number }) {
  const { type } = run.definition;
  const catalog = await loadBlockCatalog();
  const inBlocks = [...catalog.values()].some((block) => block.fields.some((field) => field.type === type));
  const collections = (await allCollections()).filter((collection) => collection.type !== "view" && collection.id >= start.collection).sort((a, b) => a.id - b.id);
  for (const collection of collections) {
    const fields = collection.fields.filter((field) => field.type === type || (inBlocks && field.type === "stream"));
    if (!fields.length) continue;
    let after = collection.id === start.collection ? start.record : 0;
    for (let more = true; more;) {
      ({ last: after, more } = await recordsDb.transaction().execute((trx) => upgradeBatch(trx, run, collection, fields, after, catalog)));
    }
    if (collection.fields.some(isIndexed)) await reindexCollection(collection);
  }
}

/** A default is stored in the shape of a value, so it moves with them. In the same transaction as starting the run, so it can't happen twice. */
async function beginRun({ definition, from, to }: Run) {
  await prisma.$transaction(async (tx) => {
    for (const field of await tx.field.findMany({ where: { type: definition.type } })) {
      const config = (field.config ?? {}) as Record<string, unknown>;
      if (config.defaultValue === undefined) continue;
      await tx.field.update({ where: { id: field.id }, data: { config: { ...config, defaultValue: upgradedValue(definition, config, config.defaultValue, from, to) } as Prisma.InputJsonValue } });
    }
    const state = { version: from, upgradingTo: to, cursorCollection: 0, cursorRecord: 0 };
    await tx.fieldValueState.upsert({ where: { type: definition.type }, create: { type: definition.type, ...state }, update: state });
  });
}

async function upgradeType(definition: FieldDefinition, batch: number) {
  const { type, version: latest = 1 } = definition;
  let state = await prisma.fieldValueState.findUnique({ where: { type } });
  if (state && Math.max(state.version, state.upgradingTo ?? 0) > latest) throw new Error(`Field type "${type}" is version ${latest}, but this database was already upgraded past that. Install the newer plugin.`);

  const finish = (version: number) => prisma.fieldValueState.update({ where: { type }, data: { version, upgradingTo: null, cursorCollection: 0, cursorRecord: 0 } });

  if (state?.upgradingTo) {
    await rewriteStoredValues({ definition, from: state.version, to: state.upgradingTo, batch }, { collection: state.cursorCollection, record: state.cursorRecord });
    state = await finish(state.upgradingTo);
  }
  const from = state?.version ?? 1;
  if (state && from === latest) return;
  const run = { definition, from, to: latest, batch };
  await beginRun(run);
  await rewriteStoredValues(run, { collection: 0, record: 0 });
  await finish(latest);
  console.info(`[fields] stored "${type}" values are now version ${latest}.`);
}

/** Runs before plugin migrations, which expect values in the current shape. A failure stops startup with nothing lost, and the next start resumes. */
export async function runFieldUpgrades({ batch = BATCH }: { batch?: number } = {}) {
  for (const definition of versionedFieldTypes()) await upgradeType(definition, batch);
}
