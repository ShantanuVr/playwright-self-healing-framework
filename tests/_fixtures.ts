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
import { JsonMetadataStore } from '../src/storage/JsonMetadataStore';
import { IMetadataStore } from '../src/storage/IMetadataStore';
import { StateReporter } from '../src/reporting/StateReporter';

export const STORAGE_PATH = path.resolve('storage/element-metadata.json');
export const REPORT_DIR = path.resolve('reports');

interface HealingFixtures {
  store: IMetadataStore;
  engine: SelfHealingEngine;
  reporter: StateReporter;
  smartPage: SmartPage;
}

export const test = base.extend<HealingFixtures>({
  store: async ({}, use) => {
    const store = new JsonMetadataStore(STORAGE_PATH);
    await store.load();
    await use(store);
  },

  engine: async ({}, use) => {
    await use(new SelfHealingEngine());
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
