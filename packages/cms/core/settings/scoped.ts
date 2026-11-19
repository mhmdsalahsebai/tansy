import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { currentScopeValue, isScopeValue } from "../scope/context";

/**
 * Settings that can differ per scope value (C29), such as one tenant's site name. Each value's
 * are a row of their own, beside the instance's, under `<key>@<value>`. Instance keys never hold
 * an "@", so no value's row can be read as the instance's, and purging a value (Phase 24) finds
 * its rows by the suffix. What a value saves is layered over the instance's when read.
 */
export const scopedSettingKey = (key: string, value: string) => {
  if (!/^[a-z][a-z0-9:-]{0,63}$/.test(key)) throw new Error(`Not a setting key: ${JSON.stringify(key)}`);
  if (!isScopeValue(value)) throw new Error(`Not a scope value: ${JSON.stringify(value)}`);
  return `${key}@${value}`;
};

/** What the current scope value saved under `key`, or null outside one or when it saved nothing. */
export async function readScopedSetting(key: string): Promise<unknown> {
  const value = currentScopeValue();
  if (value === null) return null;
  return (await prisma.appSetting.findUnique({ where: { key: scopedSettingKey(key, value) } }))?.value ?? null;
}

/** Saves `key` for the current scope value. Callers check there is one first. */
export async function writeScopedSetting(key: string, data: Prisma.InputJsonValue, updatedById: string | null) {
  const value = currentScopeValue();
  if (value === null) throw new Error("Scoped settings are saved inside a scope value.");
  const id = scopedSettingKey(key, value);
  await prisma.appSetting.upsert({
    where: { key: id },
    create: { key: id, value: data, updatedById },
    update: { value: data, updatedById, version: { increment: 1 } },
  });
}
