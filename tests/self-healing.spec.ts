/**
 * @file self-healing.spec.ts
 * @description End-to-end demonstration of the self-healing framework.
 *
 *   Test 1 (Seed run): Navigates to the ORIGINAL UI. All selectors hit
 *   first-time – the framework captures metadata for each interaction.
 *
 *   Test 2 (Heal run): Navigates to the MUTATED UI. Every id/class has
 *   changed, so every stored selector fails on the first attempt. The
 *   engine analyses the live DOM, scores candidates against the stored
 *   metadata, heals the selectors, and retries – the test passes without
 *   any code changes to the POM.
 *
 *   Test 3 (Text drift): ids/classes change again AND the visible copy
 *   drifts ("Submit Order" -> "Place Order").
 *
 *   Test 4 (Shadow DOM): the v3 form moves inside an open shadow root of a
 *   web component with new ids; the engine heals into the shadow tree.
 *
 *   Tests are declared `serial` because each one relies on the metadata
 *   healed by the previous one.
 */

import * as fs from 'fs';
import { test, expect, STORAGE_PATH } from './_fixtures';
import { CheckoutPage } from '../pages/CheckoutPage';

test.describe.configure({ mode: 'serial' });

test.describe('Self-Healing E2E Demo', () => {
  test.beforeAll(async () => {
    // Clean slate: ensure the seed run starts with an empty store so the
    // demo is deterministic on a CI machine (incl. SQLite's WAL sidecars).
    for (const file of [STORAGE_PATH, `${STORAGE_PATH}-wal`, `${STORAGE_PATH}-shm`]) {
      fs.rmSync(file, { force: true });
    }
  });

  test('1. Seed run: captures metadata from the original UI', async ({
    smartPage,
    store,
    reporter,
  }) => {
    const checkout = new CheckoutPage(smartPage);

    await checkout.load('/original.html');
    await checkout.fillEmail('alice@example.com');
    await checkout.fillCoupon('SAVE10');
    await checkout.submit();

    await expect(smartPage.raw.locator('#status-message')).toHaveText(
      /Order submitted successfully/,
    );

    // All interactions should be exact matches – no healing needed.
    expect(reporter.entries.every(e => e.strategy === 'exact')).toBe(true);

    // Metadata must have been written for every interacted element.
    expect(store.get(CheckoutPage.ELEMENTS.emailField)).toBeDefined();
    expect(store.get(CheckoutPage.ELEMENTS.couponField)).toBeDefined();
    expect(store.get(CheckoutPage.ELEMENTS.submitButton)).toBeDefined();
  });

  test('2. Heal run: recovers from full id/class mutation', async ({
    smartPage,
    reporter,
  }) => {
    const checkout = new CheckoutPage(smartPage);

    await checkout.load('/mutated.html');
    await checkout.fillEmail('alice@example.com');
    await checkout.fillCoupon('SAVE10');
    await checkout.submit();

    await expect(smartPage.raw.locator('#notification')).toHaveText(
      /Order submitted successfully/,
    );

    const healed = reporter.entries.filter(e => e.strategy === 'healed');
    const failed = reporter.entries.filter(e => e.strategy === 'failed');

    // At least one locator must have been healed – the whole point of the demo.
    expect(healed.length).toBeGreaterThan(0);
    // Nothing should slip through as unrecoverable.
    expect(failed.length).toBe(0);
    // Every heal must clear the configured confidence threshold.
    healed.forEach(h => expect(h.confidence).toBeGreaterThanOrEqual(0.6));
  });

  test('3. Text-drift run: recovers when button/label copy ALSO changes', async ({
    smartPage,
    reporter,
  }) => {
    const checkout = new CheckoutPage(smartPage);

    // Previous test healed storage to the v2 ids (e.g. #emailAddr_9f3a).
    // On v3 those too are gone AND the visible copy drifted
    // ("Submit Order" -> "Place Order", "Email address" -> "Email", etc.).
    await checkout.load('/text-drift.html');
    await checkout.fillEmail('alice@example.com');
    await checkout.fillCoupon('SAVE10');
    await checkout.submit();

    await expect(smartPage.raw.locator('#feedback')).toHaveText(
      /Order submitted successfully/,
    );

    const healed = reporter.entries.filter(e => e.strategy === 'healed');
    const failed = reporter.entries.filter(e => e.strategy === 'failed');

    expect(failed.length).toBe(0);
    expect(healed.length).toBeGreaterThan(0);
    // Confidence will be lower than the pure id/class drift – but still
    // has to clear the configured threshold.
    healed.forEach(h => expect(h.confidence).toBeGreaterThanOrEqual(0.6));
  });

  test('4. Shadow DOM run: heals into an open shadow root', async ({
    smartPage,
    reporter,
  }) => {
    const checkout = new CheckoutPage(smartPage);

    // The v3 form now renders inside <checkout-form>'s shadow root, and
    // every id changed again – invisible to page.content().
    await checkout.load('/shadow-dom.html');
    await checkout.fillEmail('alice@example.com');
    await checkout.fillCoupon('SAVE10');
    await checkout.submit();

    // The email must have landed in the email field, not a look-alike input.
    await expect(smartPage.raw.locator('#shadow-feedback')).toHaveText(
      'Order submitted successfully for alice@example.com!',
    );

    const healed = reporter.entries.filter(e => e.strategy === 'healed');
    expect(reporter.entries.filter(e => e.strategy === 'failed')).toHaveLength(0);
    expect(healed).toHaveLength(3);
    healed.forEach(h => {
      expect(h.confidence).toBeGreaterThanOrEqual(0.6);
      // XPath cannot pierce shadow roots, so every heal must be the CSS form.
      expect(h.healedSelector).not.toMatch(/^xpath=/);
    });
  });
});
