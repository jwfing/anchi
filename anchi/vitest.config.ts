import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    // Vitest's default of 5 s per test is passed now and then by ordinary tests that start a
    // process or render the TUI on a busy CI runner; a test that hangs still fails.
    testTimeout: 20_000,
  },
});
