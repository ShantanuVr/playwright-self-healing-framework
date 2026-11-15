/**
 * @file regressions.spec.ts
 * @description Browser regression guards for bugs fixed during the review.
 *              Each test fails on the code before its fix.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { SmartPage, SmartPageOptions } from '../src/core/SmartPage';
import { SelfHealingEngine } from '../src/healing/SelfHealingEngine';
import { StateReporter } from '../src/reporting/StateReporter';
import { JsonMetadataStore } from '../src/storage/JsonMetadataStore';
import { ElementMetaData } from '../src/storage/ElementMetaData';

type Win = Window & { __clicked?: string; __clicks?: number };

/** A SmartPage over its own throwaway JSON store, pre-seeded with `records`. */
async function isolatedSmartPage(
  page: Page,
  file: string,
  records: ElementMetaData[] = [],
  options: Partial<SmartPageOptions> = {},
) {
  const store = new JsonMetadataStore(file);
  await store.load();
  for (const r of records) await store.upsert(r);
  const reporter = new StateReporter(path.dirname(file));
  const smart = new SmartPage(page, {
    store,
    engine: new SelfHealingEngine(),
    reporter,
    defaultTimeoutMs: 1_000,
    ...options,
  });
  return { smart, store, reporter };
}

const fingerprint = (over: Partial<ElementMetaData>): ElementMetaData => ({
  logicalName: 'el',
  primarySelector: '#gone',
  tagName: 'button',
  classes: [],
  textContent: '',
  attributes: {},
  anchorContext: { siblingTexts: [] },
  capturedAt: '2024-01-01T00:00:00.000Z',
  ...over,
});

test.describe('Regressions', () => {
  test('an action that removes its own element runs exactly once', async ({ smartPage, reporter }) => {
    await smartPage.raw.goto('/self-removing.html');

    await smartPage.click('regression.deleteRow', '#del-1');

    // Before the fix the post-click capture timed out, was treated as a
    // broken locator, and "healed" onto the look-alike: two clicks.
    expect(await smartPage.raw.evaluate(() => (window as Win).__clicks)).toBe(1);
    expect(reporter.entries.map(e => e.strategy)).toEqual(['exact']);
    await expect(smartPage.raw.locator('#del-2')).toBeVisible();
  });

  test('readonly capture mode heals without writing the store', async ({ page }, testInfo) => {
    const file = testInfo.outputPath('meta.json');
    const seed = await isolatedSmartPage(page, file);
    await page.goto('/original.html');
    await seed.smart.click('checkout.submitButton', '[data-testid="checkout-submit"]');
    const before = fs.readFileSync(file, 'utf-8');

    const audit = await isolatedSmartPage(page, file, [], { captureMode: 'readonly' });
    await page.goto('/mutated.html');
    await audit.smart.click('checkout.submitButton', '[data-testid="checkout-submit"]');

    expect(audit.reporter.entries[0].strategy).toBe('healed');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  test('an ambiguous XPath fallback is never used', async ({ page }, testInfo) => {
    // The look-alike comes FIRST, so `.first()` on the XPath would click it.
    await page.setContent(`
      <button class="other">Pay</button>
      <button class="pay" disabled>Pay</button>
      <script>document.addEventListener('click', e => { window.__clicked = e.target.className; }, true);</script>`);
    const { smart, reporter } = await isolatedSmartPage(page, testInfo.outputPath('meta.json'), [
      fingerprint({ logicalName: 'pay', classes: ['pay'], textContent: 'Pay', attributes: { class: 'pay' }, anchorContext: { siblingTexts: ['Pay'] } }),
    ]);

    // The scored target (`button.pay`) is disabled, so the CSS attempt fails;
    // the text XPath matches both buttons and must be skipped.
    await expect(smart.click('pay')).rejects.toThrow(/XPath fallback .* skipped/);
    expect(await page.evaluate(() => (window as Win).__clicked)).toBeUndefined();
    expect(reporter.entries[0].strategy).toBe('failed');
  });

  test('a positional selector that drifted after a row insert is re-healed', async ({ page }, testInfo) => {
    const row = (name: string) => `<li><span>${name}</span><button class="del">Delete</button></li>`;
    await page.setContent(`
      <ul>${row('Alpha')}${row('Bravo')}</ul>
      <script>document.addEventListener('click', e => { window.__clicked = e.target.previousElementSibling.textContent; }, true);</script>`);
    const { smart, store, reporter } = await isolatedSmartPage(page, testInfo.outputPath('meta.json'), [
      fingerprint({ logicalName: 'row.delete', classes: ['del'], textContent: 'Delete', attributes: { class: 'del' }, anchorContext: { siblingTexts: ['Bravo'] } }),
    ]);

    // First heal: no unique selector exists, so Bravo's button is stored by index.
    await smart.click('row.delete');
    expect(store.get('row.delete')?.primarySelector).toBe('button.del >> nth=1');
    expect(await page.evaluate(() => (window as Win).__clicked)).toBe('Bravo');

    // A new row lands on top: `nth=1` now points at Alpha's button.
    await page.evaluate(() => document.querySelector('ul')!.insertAdjacentHTML('afterbegin', '<li><span>New</span><button class="del">Delete</button></li>'));
    await smart.click('row.delete');

    expect(await page.evaluate(() => (window as Win).__clicked)).toBe('Bravo');
    expect(reporter.entries[1]).toMatchObject({ strategy: 'healed', healedSelector: 'button.del >> nth=2' });
  });
});
