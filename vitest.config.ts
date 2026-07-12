import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/protocol/src/**/*.test.ts',
      'packages/server/src/**/*.test.ts',
      'packages/extension/src/**/*.unit.test.ts',
      'scripts/**/*.test.mjs',
    ],
    passWithNoTests: false,
  },
});
