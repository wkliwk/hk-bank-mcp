import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Every test must run offline against committed fixtures — no network in CI.
    testTimeout: 10_000,
  },
});
