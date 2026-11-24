import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The pricing property tests run hundreds of markets per case: 1 to 5 s alone, and CI runs
    // several packages at once, so vitest's default 5 s failed one or another of them in CI
    // runs 431 and 434. The checks are unchanged.
    testTimeout: 30_000,
  },
});
