/**
 * @file _fixtures.ts
 * @description Custom Playwright fixtures that inject the self-healing
 *              collaborators (store, engine, reporter, SmartPage) into
 *              every test with zero boilerplate.
 */

import { test as base } from '@playwright/test';
import * as path from 'path';
import { SmartPage } from '../src/core/SmartPage';
import { SelfHealingEngine } from '../src/healing/SelfHealingEngine';
import { HttpEmbeddingProvider } from '../src/healing/HttpEmbeddingProvider';
import { JsonMetadataStore } from '../src/storage/JsonMetadataStore';
import { IMetadataStore } from '../src/storage/IMetadataStore';
import { StateReporter } from '../src/reporting/StateReporter';

/** Override with SELFHEAL_STORE_PATH; a `.db` / `.sqlite` path selects SQLite. */
export const STORAGE_PATH = path.resolve(
  process.env.SELFHEAL_STORE_PATH ?? 'storage/element-metadata.json',
);
export const REPORT_DIR = path.resolve('reports');

interface HealingFixtures {
  store: IMetadataStore;
  engine: SelfHealingEngine;
  reporter: StateReporter;
  smartPage: SmartPage;
}

export const test = base.extend<HealingFixtures>({
  store: async ({}, use) => {
    if (/\.(db|sqlite)$/.test(STORAGE_PATH)) {
      // Loaded lazily: importing node:sqlite prints an ExperimentalWarning,
      // which JSON-store runs should not see. `require`, not `import()`:
      // Playwright only transpiles TypeScript on the CommonJS path.
      const { SqliteMetadataStore } =
        require('../src/storage/SqliteMetadataStore') as typeof import('../src/storage/SqliteMetadataStore');
      const store = new SqliteMetadataStore(STORAGE_PATH);
      await store.load();
      await use(store);
      store.close();
      return;
    }
    const store = new JsonMetadataStore(STORAGE_PATH);
    await store.load();
    await use(store);
  },

  engine: async ({}, use) => {
    // Opt-in Phase 5: blend embedding similarity from any OpenAI-compatible
    // endpoint, e.g. a local Ollama at http://localhost:11434/v1/embeddings.
    const url = process.env.SELFHEAL_EMBEDDINGS_URL;
    await use(
      new SelfHealingEngine(
        url
          ? {
              embeddings: {
                provider: new HttpEmbeddingProvider({
                  url,
                  model: process.env.SELFHEAL_EMBEDDINGS_MODEL ?? 'nomic-embed-text',
                  apiKey: process.env.SELFHEAL_EMBEDDINGS_API_KEY,
                }),
                // Both validated by the engine; defaults 0.5 / 0.5.
                weight: process.env.SELFHEAL_EMBEDDINGS_WEIGHT
                  ? Number(process.env.SELFHEAL_EMBEDDINGS_WEIGHT)
                  : undefined,
                baseline: process.env.SELFHEAL_EMBEDDINGS_BASELINE
                  ? Number(process.env.SELFHEAL_EMBEDDINGS_BASELINE)
                  : undefined,
              },
            }
          : {},
      ),
    );
  },

  reporter: async ({}, use, testInfo) => {
    const reporter = new StateReporter(REPORT_DIR);
    await use(reporter);
    // eslint-disable-next-line no-console
    console.log(`\n[${testInfo.title}] ${reporter.summary()}`);
    await reporter.writeToDisk(
      `heal-${testInfo.title.replace(/\W+/g, '-')}-${Date.now()}.json`,
    );
  },

  smartPage: async ({ page, store, engine, reporter }, use) => {
    const smart = new SmartPage(page, { store, engine, reporter });
    await use(smart);
  },
});

export { expect } from '@playwright/test';
