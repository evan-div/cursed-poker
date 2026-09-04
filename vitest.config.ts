import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cursed/shared': r('./shared/src/index.ts'),
      '@cursed/server': r('./server/src/index.ts'),
    },
  },
  test: {
    include: [
      'shared/**/*.test.ts',
      'server/**/*.test.ts',
      'client/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
    // The poker fuzz/simulation suites play tens of thousands of hands.
    testTimeout: 120_000,
  },
});
