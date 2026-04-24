import { defineConfig } from 'vitest/config';

/**
 * Vitest is used ONLY for pure-logic unit tests of the healing engine.
 * Playwright continues to own browser-based end-to-end tests under `tests/`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 5_000,
    coverage: {
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
