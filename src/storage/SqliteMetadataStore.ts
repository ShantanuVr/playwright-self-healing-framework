/**
 * @file SqliteMetadataStore.ts
 * @description {@link IMetadataStore} backed by a local SQLite file via
 *              Node's built-in `node:sqlite` (Node ≥ 22.13, no extra
 *              dependency). Unlike the JSON store it is safe for parallel
 *              Playwright workers: reads go straight to the database (so
 *              every worker sees the others' heals), and each upsert is a
 *              short write transaction under WAL journaling.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ElementMetaData } from './ElementMetaData';
import { IMetadataStore, mergeMetadata } from './IMetadataStore';

export class SqliteMetadataStore implements IMetadataStore {
  private readonly filePath: string;
  private db?: DatabaseSync;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  public async load(): Promise<void> {
    if (this.db) return;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    // busy_timeout first, so even the WAL switch waits out a concurrent writer.
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS element_metadata (
        logical_name TEXT PRIMARY KEY,
        data         TEXT NOT NULL
      );
    `);
    this.db = db;
  }

  public get(logicalName: string): ElementMetaData | undefined {
    const row = this.conn()
      .prepare('SELECT data FROM element_metadata WHERE logical_name = ?')
      .get(logicalName) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ElementMetaData) : undefined;
  }

  public all(): ElementMetaData[] {
    const rows = this.conn()
      .prepare('SELECT data FROM element_metadata ORDER BY logical_name')
      .all() as Array<{ data: string }>;
    return rows.map(r => JSON.parse(r.data) as ElementMetaData);
  }

  public async upsert(meta: ElementMetaData): Promise<void> {
    const db = this.conn();
    // IMMEDIATE takes the write lock up front, so the read-merge-write
    // cannot interleave with another worker's upsert of the same record.
    db.exec('BEGIN IMMEDIATE');
    try {
      const merged = mergeMetadata(this.get(meta.logicalName), meta);
      db.prepare(
        `INSERT INTO element_metadata (logical_name, data) VALUES (?, ?)
         ON CONFLICT(logical_name) DO UPDATE SET data = excluded.data`,
      ).run(meta.logicalName, JSON.stringify(merged));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** No-op: every upsert is committed immediately. */
  public async flush(): Promise<void> {}

  /** Closes the connection (checkpointing the WAL). `load()` reopens it. */
  public close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private conn(): DatabaseSync {
    if (!this.db) {
      throw new Error('[SqliteMetadataStore] Call load() before reading or writing.');
    }
    return this.db;
  }
}
