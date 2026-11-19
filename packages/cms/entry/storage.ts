export { localStorage } from "../core/storage/local";
export { s3Storage } from "../core/storage/s3";
export { bodyBlob, callProvider, rangeOf, StorageProviderError } from "../core/storage/remote";
export type { ProviderCall } from "../core/storage/remote";
export type { StorageAdapter, StorageConfig, StoredObject, ThumbnailOptions } from "../core/storage/types";
export type { BackupConfig } from "../core/backup/config";
