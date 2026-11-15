/**
 * @file regressions.spec.ts
 * @description Browser regression guards for bugs fixed during the review.
 */

import { test, expect } from './_fixtures';

test.describe('Regressions', () => {
  test('an action that removes its own element runs exactly once', async ({ smartPage, reporter }) => {
    await smartPage.raw.goto('/self-removing.html');

    await smartPage.click('regression.deleteRow', '#del-1');

    // Before the fix the post-click capture timed out, was treated as a
    // broken locator, and "healed" onto the look-alike: two clicks.
    expect(await smartPage.raw.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
    expect(reporter.entries.map(e => e.strategy)).toEqual(['exact']);
    await expect(smartPage.raw.locator('#del-2')).toBeVisible();
  });
});
