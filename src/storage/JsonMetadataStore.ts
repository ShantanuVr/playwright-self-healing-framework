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
import { IMetadataStore } from './IMetadataStore';

export class JsonMetadataStore implements IMetadataStore {
  private readonly filePath: string;
  private readonly cache: Map<string, ElementMetaData> = new Map();
  private loaded = false;
  private writes = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    if (!fs.existsSync(this.filePath)) {
      await this.ensureDirectory();
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
      await fs.promises.rename(this.filePath, backup);
      console.warn(`[JsonMetadataStore] Unreadable metadata moved to ${backup}; starting empty.`);
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
    const existing = this.cache.get(meta.logicalName);
    const merged: ElementMetaData = existing
      ? {
          ...existing,
          ...meta,
          // Preserve the audit trail unless the incoming record extends it.
          healedFrom: meta.healedFrom ?? existing.healedFrom,
        }
      : meta;
    this.cache.set(meta.logicalName, merged);
    await this.flush();
  }

  public async flush(): Promise<void> {
    await this.ensureDirectory();
    const payload = JSON.stringify(Array.from(this.cache.values()), null, 2);
    // Write-then-rename: a crash mid-write never leaves a truncated file.
    const tmp = `${this.filePath}.${process.pid}-${++this.writes}.tmp`;
    await fs.promises.writeFile(tmp, payload, 'utf-8');
    await fs.promises.rename(tmp, this.filePath);
  }

  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
  }
}
