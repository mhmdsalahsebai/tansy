import type { Prisma } from "../../generated/client-sqlite";

/** One entry of a storage index, as `list` reports it. */
export interface StorageIndexEntry<Value> {
  key: string;
  value: Value;
}

/**
 * Where an adapter remembers what a provider made of each key, for a provider that picks its own
 * address for an upload and can't be asked for it again, such as an image host that answers an
 * upload with a URL. Kept in the database beside everything else, so a backup holds it.
 */
export interface StorageIndex<Value> {
  /** Null when nothing is kept under the key. */
  get(key: string): Promise<Value | null>;
  set(key: string, value: Value): Promise<void>;
  /** Succeeds when nothing is kept under the key. */
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with `prefix`, in key order. */
  list(prefix: string): Promise<Array<StorageIndexEntry<Value>>>;
}

const MAX_KEY_LENGTH = 1000;
const MAX_VALUE_BYTES = 16 * 1024;

function assertKey(key: string) {
  if (!key || key.length > MAX_KEY_LENGTH) throw new Error("A storage index key must be 1 to 1000 characters.");
}

function jsonValue(value: unknown) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("A storage index value must be JSON.");
  if (Buffer.byteLength(text) > MAX_VALUE_BYTES) throw new Error(`A storage index value can be at most ${MAX_VALUE_BYTES} bytes.`);
  return value as Prisma.InputJsonValue;
}

/** Loaded on first use, so a config file that builds an adapter doesn't open the database. */
const database = async () => (await import("../../lib/prisma")).default;

/**
 * The index of the storage adapter named `adapterName`. Keys are core's storage keys, which hold no
 * user input. The index is one per adapter, not per scope value: a scope value's files already sit
 * under keys of their own, and the adapter removes their entries as core deletes them.
 *
 * The values are the adapter's own, so it checks what it reads back as it would a provider's answer.
 */
export function storageIndex<Value = unknown>(adapterName: string): StorageIndex<Value> {
  if (!adapterName) throw new Error("A storage index needs its adapter's name.");
  // Plugin names can't hold a colon, so no plugin's store can reach this namespace.
  const plugin = `storage:${adapterName}`;
  return {
    async get(key) {
      assertKey(key);
      const row = await (await database()).pluginData.findUnique({ where: { plugin_key: { plugin, key } } });
      return row ? (row.value as Value) : null;
    },
    async set(key, value) {
      assertKey(key);
      const data = { value: jsonValue(value) };
      await (await database()).pluginData.upsert({ where: { plugin_key: { plugin, key } }, create: { plugin, key, ...data }, update: data });
    },
    async delete(key) {
      assertKey(key);
      await (await database()).pluginData.deleteMany({ where: { plugin, key } });
    },
    async list(prefix) {
      const rows = await (await database()).pluginData.findMany({ where: { plugin, key: { startsWith: prefix } }, orderBy: { key: "asc" } });
      return rows.map(({ key, value }) => ({ key, value: value as Value }));
    },
  };
}
