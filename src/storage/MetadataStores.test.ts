/**
 * @file MetadataStores.test.ts
 * @description One contract, run against both storage backends, plus the
 *              backend-specific guarantees (JSON crash-safety, SQLite
 *              cross-worker freshness). Uses throwaway temp directories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ElementMetaData } from './ElementMetaData';
import { IMetadataStore } from './IMetadataStore';
import { JsonMetadataStore } from './JsonMetadataStore';
import { SqliteMetadataStore } from './SqliteMetadataStore';

const meta = (logicalName: string, over: Partial<ElementMetaData> = {}): ElementMetaData => ({
  logicalName,
  primarySelector: `#${logicalName}`,
  tagName: 'button',
  classes: ['btn'],
  textContent: 'Go',
  attributes: { class: 'btn' },
  anchorContext: { siblingTexts: ['Cancel'] },
  capturedAt: '2024-01-01T00:00:00.000Z',
  ...over,
});

let dir: string;
const opened: SqliteMetadataStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-store-'));
});
afterEach(() => {
  opened.splice(0).forEach(s => s.close());
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const backends: Array<[string, (file: string) => IMetadataStore, string]> = [
  ['JsonMetadataStore', file => new JsonMetadataStore(file), 'meta.json'],
  [
    'SqliteMetadataStore',
    file => {
      const store = new SqliteMetadataStore(file);
      opened.push(store);
      return store;
    },
    'meta.db',
  ],
];

describe.each(backends)('%s – IMetadataStore contract', (_name, create, fileName) => {
  const open = async (): Promise<IMetadataStore> => {
    const store = create(path.join(dir, 'nested', fileName));
    await store.load();
    return store;
  };

  it('round-trips records through the backing file', async () => {
    await (await open()).upsert(meta('submit'));
    const reopened = await open();
    expect(reopened.get('submit')).toEqual(meta('submit'));
    expect(reopened.all()).toHaveLength(1);
  });

  it('returns undefined for unknown names and lists every record', async () => {
    const store = await open();
    expect(store.get('nope')).toBeUndefined();
    await store.upsert(meta('a'));
    await store.upsert(meta('b'));
    expect(store.all().map(m => m.logicalName).sort()).toEqual(['a', 'b']);
  });

  it('keeps the healedFrom trail unless the incoming record extends it', async () => {
    const store = await open();
    await store.upsert(meta('x', { healedFrom: ['#old'] }));
    await store.upsert(meta('x', { primarySelector: '#new' }));
    expect(store.get('x')).toMatchObject({ primarySelector: '#new', healedFrom: ['#old'] });
    await store.upsert(meta('x', { healedFrom: ['#old', '#new'] }));
    expect(store.get('x')?.healedFrom).toEqual(['#old', '#new']);
  });

  it('treats load() as idempotent and flush() as safe at any time', async () => {
    const store = await open();
    await store.upsert(meta('a'));
    await store.load();
    await store.flush();
    expect(store.get('a')).toBeDefined();
  });
});

describe('JsonMetadataStore – crash safety', () => {
  const file = (): string => path.join(dir, 'meta.json');

  it('keeps every record when upserts run concurrently, and leaves no temp files', async () => {
    const store = new JsonMetadataStore(file());
    await store.load();
    // Unqueued flushes can finish out of order and let an older snapshot win.
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.upsert(meta(`el${i}`))));
    expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toHaveLength(20);
  });

  it.each([
    ['unparsable JSON', '{ not json'],
    ['valid JSON that is not an array', '{"logicalName":"x"}'],
  ])('backs up %s instead of overwriting it, then starts empty', async (_label, content) => {
    fs.writeFileSync(file(), content);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new JsonMetadataStore(file());
    await store.load();
    expect(store.all()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();

    await store.upsert(meta('fresh'));
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('meta.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toBe(content);
  });

  it('skips entries that have no logicalName', async () => {
    fs.writeFileSync(file(), JSON.stringify([{ foo: 1 }, meta('ok')]));
    const store = new JsonMetadataStore(file());
    await store.load();
    expect(store.all().map(m => m.logicalName)).toEqual(['ok']);
  });
});

describe('SqliteMetadataStore – backend specifics', () => {
  const file = (): string => path.join(dir, 'meta.db');
  const openStore = async (): Promise<SqliteMetadataStore> => {
    const store = new SqliteMetadataStore(file());
    opened.push(store);
    await store.load();
    return store;
  };

  it('throws a clear error when used before load()', () => {
    const store = new SqliteMetadataStore(file());
    expect(() => store.get('x')).toThrow(/load\(\)/);
    expect(() => store.all()).toThrow(/load\(\)/);
  });

  it('lets two connections (e.g. two workers) see and extend each other\'s records', async () => {
    const workerA = await openStore();
    const workerB = await openStore();
    await workerA.upsert(meta('x', { healedFrom: ['#v1'] }));
    expect(workerB.get('x')?.healedFrom).toEqual(['#v1']);
    // B's upsert must merge with A's row, not with a stale in-memory copy.
    await workerB.upsert(meta('x', { primarySelector: '#v3' }));
    expect(workerA.get('x')).toMatchObject({ primarySelector: '#v3', healedFrom: ['#v1'] });
  });

  it('runs in WAL mode and survives close() + load()', async () => {
    const store = await openStore();
    await store.upsert(meta('a'));
    store.close();
    await store.load();
    expect(store.get('a')).toBeDefined();

    const raw = new DatabaseSync(file());
    expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    raw.close();
  });
});

describe('JsonMetadataStore – unreadable file that cannot be moved aside', () => {
  // chmod cannot stop root, and Windows has no POSIX directory modes.
  const canRestrict = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canRestrict)('starts empty without crashing, and refuses to overwrite the file', async () => {
    const file = path.join(dir, 'meta.json');
    fs.writeFileSync(file, '{ truncated');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fs.chmodSync(dir, 0o555); // read-only directory: rename (backup) fails
    try {
      const store = new JsonMetadataStore(file);
      await store.load();
      expect(store.all()).toEqual([]);
      await expect(store.upsert(meta('x'))).rejects.toThrow(/Refusing to overwrite/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ truncated');
  });
});
