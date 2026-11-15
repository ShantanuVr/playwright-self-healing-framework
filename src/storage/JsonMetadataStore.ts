/**
 * @file JsonMetadataStore.ts
 * @description File-backed {@link IMetadataStore} implementation using a
 *              single JSON document on disk. Chosen for Phase 1 because
 *              it is zero-config, human-inspectable, diffable in PRs, and
 *              trivially swappable for SQLite/Redis later on.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ElementMetaData } from './ElementMetaData';
import { IMetadataStore, mergeMetadata } from './IMetadataStore';
import { writeFileAtomic } from './writeFileAtomic';

export class JsonMetadataStore implements IMetadataStore {
  private readonly filePath: string;
  private readonly cache: Map<string, ElementMetaData> = new Map();
  private loaded = false;
  /** Set when an unreadable file could not be moved aside: never overwrite it. */
  private protectedCorruptFile = false;
  /** Tail of the write queue: flushes run one at a time, in call order. */
  private writing: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    if (!fs.existsSync(this.filePath)) {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      this.loaded = true;
      return;
    }

    const raw = await fs.promises.readFile(this.filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed as ElementMetaData[]) {
        if (typeof entry?.logicalName === 'string') this.cache.set(entry.logicalName, entry);
      }
    } else {
      // Corrupt file: move it aside so the next flush cannot overwrite the
      // only copy, then continue empty rather than crashing the suite.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await fs.promises.rename(this.filePath, backup);
        console.warn(`[JsonMetadataStore] Unreadable metadata moved to ${backup}; starting empty.`);
      } catch (err) {
        // e.g. a read-only checkout: stay usable, but never overwrite it.
        this.protectedCorruptFile = true;
        console.warn(
          `[JsonMetadataStore] ${this.filePath} is unreadable and could not be backed up ` +
            `(${(err as Error).message}); starting empty without overwriting it.`,
        );
      }
    }
    this.loaded = true;
  }

  public get(logicalName: string): ElementMetaData | undefined {
    return this.cache.get(logicalName);
  }

  public all(): ElementMetaData[] {
    return Array.from(this.cache.values());
  }

  public async upsert(meta: ElementMetaData): Promise<void> {
    this.cache.set(meta.logicalName, mergeMetadata(this.cache.get(meta.logicalName), meta));
    await this.flush();
  }

  public async flush(): Promise<void> {
    if (this.protectedCorruptFile) {
      throw new Error(
        `[JsonMetadataStore] Refusing to overwrite unreadable ${this.filePath}; repair or remove it.`,
      );
    }
    // Queue the write and snapshot the cache only when it starts: concurrent
    // flushes could otherwise finish out of order, and an older snapshot
    // landing last would drop records from disk.
    const write = this.writing.then(() =>
      writeFileAtomic(this.filePath, JSON.stringify(Array.from(this.cache.values()), null, 2)),
    );
    this.writing = write.catch(() => undefined);
    await write;
  }
}
