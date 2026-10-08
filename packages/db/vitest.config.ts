import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests create and migrate a throwaway PostgreSQL database.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
