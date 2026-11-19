import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import type { PluginStore } from "./define";
import { currentScopeValue } from "../scope/context";

const KEY = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_VALUE_BYTES = 256 * 1024;

function assertKey(key: string) {
  if (!KEY.test(key)) throw new Error(`Invalid store key "${key.slice(0, 40)}". Use letters, digits and . _ : / -, at most 200 characters.`);
}

function jsonValue(value: unknown) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("A stored value must be JSON.");
  if (Buffer.byteLength(text) > MAX_VALUE_BYTES) throw new Error(`A stored value can be at most ${MAX_VALUE_BYTES} bytes.`);
  return value as Prisma.InputJsonValue;
}

/**
 * One namespace per plugin, and within a scope value one per value (C31): work for tenant A
 * reads and writes `<plugin>@A`, never B's keys or the instance's. Plugin names can't hold an
 * "@", so no plugin reaches another's namespace, and purging a value (Phase 24) finds its rows
 * by the suffix. Read at each call, so a store kept from one piece of work follows the next.
 * The namespace comes from core, so a plugin can't name another's.
 */
export function pluginStore(source: string): PluginStore {
  const space = () => {
    const value = currentScopeValue();
    return value === null ? source : `${source}@${value}`;
  };
  return {
    async get(key) {
      assertKey(key);
      const plugin = space();
      return (await prisma.pluginData.findUnique({ where: { plugin_key: { plugin, key } } }))?.value ?? null;
    },
    async set(key, value) {
      assertKey(key);
      const plugin = space();
      const data = { value: jsonValue(value) };
      await prisma.pluginData.upsert({ where: { plugin_key: { plugin, key } }, create: { plugin, key, ...data }, update: data });
    },
    async claim(key, value) {
      assertKey(key);
      const plugin = space();
      // A plain insert: the primary key makes the database pick exactly one winner.
      try {
        await prisma.pluginData.create({ data: { plugin, key, value: jsonValue(value) } });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") return false;
        throw error;
      }
    },
    async delete(key) {
      assertKey(key);
      const plugin = space();
      await prisma.pluginData.deleteMany({ where: { plugin, key } });
    },
    async list(prefix = "", options = {}) {
      const { before, order = "asc", limit } = options;
      const plugin = space();
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("A store list's limit must be a positive whole number.");
      const rows = await prisma.pluginData.findMany({
        where: { plugin, key: { startsWith: prefix, ...(before === undefined ? {} : { lt: before }) } },
        orderBy: { key: order },
        ...(limit === undefined ? {} : { take: limit }),
      });
      return rows.map(({ key, value }) => ({ key, value }));
    },
    async deleteMany(prefix, options = {}) {
      const plugin = space();
      const { count } = await prisma.pluginData.deleteMany({ where: { plugin, key: { startsWith: prefix, ...(options.before === undefined ? {} : { lt: options.before }) } } });
      return count;
    },
  };
}
