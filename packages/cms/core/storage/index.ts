import { getCmsConfig } from "../config";
import { HttpError } from "../http/errors";
import type { StorageAdapter, StorageConfig } from "./types";

export type { StorageAdapter, StorageConfig } from "./types";

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function allAdapters(config: StorageConfig | undefined) {
  return config ? [config.adapter, ...(config.previous ?? [])] : [];
}

/** Stops startup on a configuration that must not run, including local storage in production. */
export function assertStorageUsable(config: StorageConfig | undefined = getCmsConfig().storage) {
  const seen = new Set<string>();
  for (const adapter of allAdapters(config)) {
    if (seen.has(adapter.name)) throw new Error(`Two storage adapters are named "${adapter.name}". Give each a unique name.`);
    seen.add(adapter.name);
    adapter.assertUsable?.();
  }
}

/** Next.js only logs an error thrown during startup and carries on serving, so refusing has to end the process. */
export function exitIfStorageUnusable() {
  try {
    assertStorageUsable();
  } catch (error) {
    console.error(`[storage] refusing to start: ${(error as Error).message}`);
    process.exit(1);
  }
}

const unavailable = () => new HttpError(503, "STORAGE_UNAVAILABLE", "File storage is not available.");

function usable(adapter: StorageAdapter) {
  try {
    adapter.assertUsable?.();
  } catch (error) {
    console.error("[storage]", error);
    throw unavailable();
  }
  return adapter;
}

export function uploadAdapter(config: StorageConfig | undefined = getCmsConfig().storage): StorageAdapter {
  if (!config) throw unavailable();
  return usable(config.adapter);
}

/** The adapter holding an existing file. Refuses, rather than guesses, if it is no longer configured. */
export function adapterNamed(name: string, config: StorageConfig | undefined = getCmsConfig().storage): StorageAdapter {
  const adapter = allAdapters(config).find((candidate) => candidate.name === name);
  if (!adapter) throw unavailable();
  return usable(adapter);
}

export const maxUploadBytes = (config: StorageConfig | undefined = getCmsConfig().storage) => config?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
