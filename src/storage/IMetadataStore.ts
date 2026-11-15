/**
 * @file IMetadataStore.ts
 * @description Storage abstraction for element metadata.
 *
 * Following the Dependency-Inversion Principle, the healing engine and the
 * SmartPage wrapper depend on this interface rather than on a concrete
 * implementation. Swapping JSON for SQLite, Redis or a remote service only
 * requires a new class implementing {@link IMetadataStore}.
 */

import { ElementMetaData } from './ElementMetaData';

export interface IMetadataStore {
  /** Loads persisted data into memory. Idempotent. */
  load(): Promise<void>;

  /** Returns metadata for a given logical name, or `undefined` if absent. */
  get(logicalName: string): ElementMetaData | undefined;

  /** Returns all known records. */
  all(): ElementMetaData[];

  /** Inserts or updates a record and persists to the underlying medium. */
  upsert(meta: ElementMetaData): Promise<void>;

  /** Explicitly flush in-memory state to disk. */
  flush(): Promise<void>;
}

/**
 * Upsert merge shared by every backend: the incoming record wins field by
 * field, but the `healedFrom` audit trail is kept unless the incoming
 * record extends it.
 */
export function mergeMetadata(
  existing: ElementMetaData | undefined,
  incoming: ElementMetaData,
): ElementMetaData {
  return existing
    ? { ...existing, ...incoming, healedFrom: incoming.healedFrom ?? existing.healedFrom }
    : incoming;
}
