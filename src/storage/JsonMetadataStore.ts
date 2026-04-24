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
    try {
      const parsed = JSON.parse(raw) as ElementMetaData[];
      if (Array.isArray(parsed)) {
        for (const entry of parsed) this.cache.set(entry.logicalName, entry);
      }
    } catch {
      // Corrupt file – treat as empty rather than crashing the suite.
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
    await fs.promises.writeFile(this.filePath, payload, 'utf-8');
  }

  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
  }
}
