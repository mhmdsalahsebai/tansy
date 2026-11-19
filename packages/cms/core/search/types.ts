/** One record's searchable text, or one translation's for a localized collection. */
export interface SearchDocument {
  collectionId: number;
  recordId: number;
  /** Never empty: a record with no searchable text is removed instead. */
  text: string;
  /** Set for a localized collection, which sends one document per record and language. */
  locale?: string;
  /**
   * The record's scope value, such as a tenant, on a scoped collection (core/scope). Store it
   * so `search` can match within one value: otherwise another value's hits fill the limit.
   */
  scope?: string;
}

/**
 * Hands search to an outside engine, such as @tansy/search-meilisearch. Register it as
 * `search` in tansy.config.ts. Core queues every change in the write's own transaction and
 * sends it after the write commits, retrying until the engine takes it, so a write never
 * waits for or fails on the engine. Results only narrow a list, so the collection's rules
 * still decide what a caller gets. See docs/guides/search.md.
 */
export interface SearchAdapter {
  /** Lowercase, such as "meilisearch". Shown in logs. */
  name: string;
  /**
   * Which index it writes to, such as the host and index name. When it differs from the
   * one the database was last indexed into, core rebuilds the whole index. Defaults to `name`.
   */
  target?: string;
  /**
   * Creates the index and the settings it needs, such as filterable attributes. Called
   * before the first change is sent after each start, and again after it fails. Must be
   * safe to repeat.
   */
  setup?(): Promise<void>;
  /** Adds or replaces one document. */
  index(document: SearchDocument): Promise<void>;
  /** Without `locale`, removes every language's document for the record. Removing one that isn't there succeeds. */
  remove(collectionId: number, recordId: number, locale?: string): Promise<void>;
  removeCollection(collectionId: number): Promise<void>;
  /**
   * Matching record ids, best first. At most `limit`. For a localized collection,
   * `locale` is the language asked for, and only documents in it may match. `query` is
   * plain words, the last of which may be the start of a word. `scope`, when given, is the
   * scope value the search is for: only documents indexed with it may match. Core narrows
   * results to the value either way, so this only keeps other values' hits out of the limit.
   */
  search(collectionId: number, query: string, limit: number, locale?: string, scope?: string): Promise<number[]>;
}
